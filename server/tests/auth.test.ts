import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Credential, FacultyProfile, Session, StudentProfile, User } from '../src/models.js';
import {
  PASSWORD,
  PNG,
  createFaculty,
  createStudent,
  facultyPayload,
  loginAs,
  studentPayload,
  useTestApp,
} from './helpers.js';

const t = useTestApp('auth');

describe('student registration and login', () => {
  it('registers a student with the student role and lets them sign in', async () => {
    const payload = studentPayload();
    const res = await request(t.app).post('/api/auth/register/student').send(payload).expect(201);
    expect(res.body.user).toMatchObject({ role: 'student', accountStatus: 'active', username: payload.username });

    const agent = await loginAs(t.app, payload.username, 'student');
    const me = await agent.get('/api/me').expect(200);
    expect(me.body.user.role).toBe('student');
    expect(me.body.studentProfile.usn).toBe(payload.usn);
  });

  it('never stores the password in MongoDB in plaintext', async () => {
    const { username } = await createStudent(t.app);
    const user = await User.findOne({ username }).lean();
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
    const credentials = await Credential.find().lean();
    expect(JSON.stringify(credentials)).not.toContain(PASSWORD);
    expect(credentials[0].passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it('validates every field on the server', async () => {
    const res = await request(t.app)
      .post('/api/auth/register/student')
      .send({ fullName: 'A', usn: 'nope', email: 'not-an-email', phone: '12', username: 'x!', password: 'short', confirmPassword: 'different' })
      .expect(400);
    expect(Object.keys(res.body.details).sort()).toEqual(
      ['confirmPassword', 'email', 'fullName', 'password', 'phone', 'usn', 'username'].sort(),
    );
    expect(await User.countDocuments()).toBe(0);
  });

  it.each(['usn', 'email', 'username'])('rejects a duplicate %s', async (field) => {
    const first = studentPayload();
    await request(t.app).post('/api/auth/register/student').send(first).expect(201);
    const res = await request(t.app)
      .post('/api/auth/register/student')
      .send(studentPayload({ [field]: (first as Record<string, unknown>)[field] }))
      .expect(409);
    expect(res.body.details).toHaveProperty(field);
    expect(await User.countDocuments()).toBe(1);
    // The failed attempt must not leave an orphaned credential behind.
    expect(await Credential.countDocuments()).toBe(1);
  });

  it('treats usernames case-insensitively for uniqueness and login', async () => {
    const payload = studentPayload({ username: 'MixedCase' });
    await request(t.app).post('/api/auth/register/student').send(payload).expect(201);
    await request(t.app).post('/api/auth/register/student').send(studentPayload({ username: 'mixedcase' })).expect(409);
    await request(t.app).post('/api/auth/login').send({ username: 'MIXEDCASE', password: PASSWORD, role: 'student' }).expect(200);
  });

  it('refuses a role supplied in the registration payload', async () => {
    for (const role of ['organizer', 'faculty', 'admin']) {
      await request(t.app).post('/api/auth/register/student').send(studentPayload({ role })).expect(400);
    }
    await request(t.app).post('/api/auth/register/student').send(studentPayload({ accountStatus: 'active', isAdmin: true })).expect(400);
    expect(await User.countDocuments()).toBe(0);
  });

  it('has no organizer registration and no administrator area at all', async () => {
    await request(t.app).post('/api/auth/register/admin').send(studentPayload()).expect(404);
    await request(t.app).post('/api/auth/register/organizer').send(studentPayload()).expect(404);
    await request(t.app).post('/api/auth/register').send(studentPayload({ role: 'admin' })).expect(404);
    await request(t.app).get('/api/admin/faculty').expect(404);
  });
});

describe('profile photo upload', () => {
  const register = (file: Buffer, name: string) => {
    const req = request(t.app).post('/api/auth/register/student');
    for (const [key, value] of Object.entries(studentPayload())) req.field(key, String(value));
    return req.attach('photo', file, name);
  };

  it('accepts a real image and serves it only to authorized viewers', async () => {
    const res = await register(PNG, 'me.png').expect(201);
    expect(res.body.user.hasPhoto).toBe(true);

    const owner = await loginAs(t.app, res.body.user.username, 'student');
    const photo = await owner.get(`/api/users/${res.body.user.id}/photo`).expect(200);
    expect(photo.headers['content-type']).toBe('image/png');

    const other = await createStudent(t.app);
    const otherAgent = await loginAs(t.app, other.username, 'student');
    await otherAgent.get(`/api/users/${res.body.user.id}/photo`).expect(403);
    await request(t.app).get(`/api/users/${res.body.user.id}/photo`).expect(401);
  });

  it('rejects a non-image disguised with an image name and MIME type', async () => {
    const res = await request(t.app)
      .post('/api/auth/register/student')
      .field(studentPayload() as never)
      .attach('photo', Buffer.from('<script>alert(1)</script> padding padding'), { filename: 'evil.png', contentType: 'image/png' })
      .expect(400);
    expect(res.body.details.photo).toBeDefined();
    expect(await User.countDocuments()).toBe(0);
  });

  it('rejects an oversized photo', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(t.ctx.config.maxPhotoBytes)]);
    await register(big, 'big.png').expect(400);
    expect(await User.countDocuments()).toBe(0);
  });
});

describe('faculty registration and verification', () => {
  it('requires an institutional email and a valid faculty ID', async () => {
    const res = await request(t.app)
      .post('/api/auth/register/faculty')
      .send(facultyPayload({ email: 'someone@gmail.com', facultyId: '!!' }))
      .expect(400);
    expect(res.body.details).toHaveProperty('email');
    expect(res.body.details).toHaveProperty('facultyId');
  });

  it('activates a faculty account as soon as its credentials validate', async () => {
    const payload = facultyPayload();
    const res = await request(t.app).post('/api/auth/register/faculty').send(payload).expect(201);
    expect(res.body.user).toMatchObject({ role: 'faculty', accountStatus: 'active' });
    expect((await FacultyProfile.findOne({ userId: res.body.user.id }))?.verificationStatus).toBe('approved');

    const agent = await loginAs(t.app, payload.username, 'faculty');
    await agent.get('/api/faculty/promotion-requests').expect(200);
  });

  it('only accepts faculty IDs on the institution list when one is configured', async () => {
    t.ctx.config.facultyIdAllowlist = ['fac-0001'];
    t.app = createApp(t.ctx);
    try {
      const refused = await request(t.app).post('/api/auth/register/faculty').send(facultyPayload({ facultyId: 'FAC-9999' })).expect(400);
      expect(refused.body.details).toHaveProperty('facultyId');
      expect(await User.countDocuments()).toBe(0);

      await request(t.app).post('/api/auth/register/faculty').send(facultyPayload({ facultyId: 'fac-0001' })).expect(201);
      // A listed ID can only be claimed once.
      await request(t.app).post('/api/auth/register/faculty').send(facultyPayload({ facultyId: 'FAC-0001' })).expect(409);
    } finally {
      t.ctx.config.facultyIdAllowlist = [];
    }
  });

  it('cannot be reached through student registration or a role field', async () => {
    await request(t.app).post('/api/auth/register/student').send(studentPayload({ role: 'faculty' })).expect(400);
    await request(t.app).post('/api/auth/register/student').send(studentPayload({ facultyId: 'FAC-1' })).expect(400);
    const student = await createStudent(t.app);
    await (await loginAs(t.app, student.username, 'student')).get('/api/faculty/promotion-requests').expect(403);
  });

  it('locks a faculty member out when their faculty profile is withdrawn', async () => {
    const faculty = await createFaculty(t.app);
    const agent = await loginAs(t.app, faculty.username, 'faculty');
    await FacultyProfile.updateOne({ userId: faculty.id }, { verificationStatus: 'rejected' });
    await agent.get('/api/faculty/promotion-requests').expect(403);
    await request(t.app).post('/api/auth/login').send({ username: faculty.username, password: PASSWORD, role: 'faculty' }).expect(403);
  });
});

describe('login role check', () => {
  it('denies access when the requested role is not the account role', async () => {
    const student = await createStudent(t.app);
    for (const role of ['faculty', 'organizer']) {
      const res = await request(t.app).post('/api/auth/login').send({ username: student.username, password: PASSWORD, role }).expect(403);
      expect(res.body.code).toBe('ROLE_MISMATCH');
      expect(res.headers['set-cookie']).toBeUndefined();
      // The response must not reveal which role the account actually has.
      expect(JSON.stringify(res.body)).not.toContain('student');
    }
    expect(await Session.countDocuments()).toBe(0);

    const faculty = await createFaculty(t.app);
    await request(t.app).post('/api/auth/login').send({ username: faculty.username, password: PASSWORD, role: 'student' }).expect(403);
  });

  it('gives the same answer for an unknown user and a wrong password', async () => {
    const student = await createStudent(t.app);
    const wrong = await request(t.app).post('/api/auth/login').send({ username: student.username, password: 'Wrong1234', role: 'student' }).expect(401);
    const unknown = await request(t.app).post('/api/auth/login').send({ username: 'nobody', password: 'Wrong1234', role: 'student' }).expect(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('rejects a login without a valid role', async () => {
    const student = await createStudent(t.app);
    await request(t.app).post('/api/auth/login').send({ username: student.username, password: PASSWORD }).expect(400);
    await request(t.app).post('/api/auth/login').send({ username: student.username, password: PASSWORD, role: 'superuser' }).expect(400);
    await request(t.app).post('/api/auth/login').send({ username: student.username, password: PASSWORD, role: 'admin' }).expect(400);
  });
});

describe('sessions', () => {
  it('rejects missing, forged, expired and logged-out sessions', async () => {
    const student = await createStudent(t.app);
    await request(t.app).get('/api/me').expect(401);
    await request(t.app).get('/api/me').set('Cookie', 'vtx_session=forged-token').expect(401);

    const agent = await loginAs(t.app, student.username, 'student');
    await agent.get('/api/me').expect(200);

    await Session.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    await agent.get('/api/me').expect(401);

    const fresh = await loginAs(t.app, student.username, 'student');
    await fresh.post('/api/auth/logout').expect(200);
    await fresh.get('/api/me').expect(401);
  });

  it('sets an httpOnly cookie and stores only a hash of the token', async () => {
    const student = await createStudent(t.app);
    const res = await request(t.app).post('/api/auth/login').send({ username: student.username, password: PASSWORD, role: 'student' }).expect(200);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const token = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
    expect(await Session.exists({ tokenHash: token })).toBeNull();
  });

  it('ends the session when the account is suspended', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    await User.updateOne({ _id: student.id }, { accountStatus: 'suspended' });
    await agent.get('/api/me').expect(401);
    await request(t.app).post('/api/auth/login').send({ username: student.username, password: PASSWORD, role: 'student' }).expect(403);
  });

  it('blocks state-changing requests from an unknown origin', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');
    await agent.post('/api/promotion-requests').set('Origin', 'https://evil.example').send({}).expect(403);
    await agent.post('/api/promotion-requests').set('Origin', 'http://localhost:5173').send({}).expect(201);
  });

  it('rate limits repeated login attempts', async () => {
    t.ctx.rateLimits.enabled = true;
    const app = createApp(t.ctx);
    const attempt = () => request(app).post('/api/auth/login').send({ username: 'nobody', password: 'Wrong1234', role: 'student' });
    for (let i = 0; i < t.ctx.rateLimits.authMax; i++) await attempt().expect(401);
    const limited = await attempt().expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });
});

describe('editing your own profile', () => {
  it('allows permitted fields and refuses role or identity changes', async () => {
    const student = await createStudent(t.app);
    const agent = await loginAs(t.app, student.username, 'student');

    const ok = await agent.patch('/api/me').send({ fullName: 'New Name', phone: '9123456780' }).expect(200);
    expect(ok.body.user.fullName).toBe('New Name');

    for (const body of [{ role: 'organizer' }, { role: 'admin' }, { accountStatus: 'active' }, { username: 'other' }, { email: 'x@y.com' }, { fullName: 'Ok Name', role: 'faculty' }]) {
      await agent.patch('/api/me').send(body).expect(400);
    }
    const user = await User.findById(student.id);
    expect(user).toMatchObject({ role: 'student', fullName: 'New Name', username: student.username });
    expect(await StudentProfile.countDocuments({ userId: student.id, usn: student.usn })).toBe(1);
  });
});
