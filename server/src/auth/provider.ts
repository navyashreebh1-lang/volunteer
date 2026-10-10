import bcrypt from 'bcryptjs';
import { Credential } from '../models.js';

/**
 * Credential handling sits behind this small interface so the rest of the
 * code never touches password hashes directly. Sign-in is by username; the
 * backend resolves it to an identity itself.
 */
export interface AuthProvider {
  readonly name: 'local';
  createIdentity(email: string, password: string): Promise<string>;
  /** `identity` is null when the username did not resolve to an account. */
  verifyPassword(identity: { authId: string; email: string } | null, password: string): Promise<boolean>;
  deleteIdentity(authId: string): Promise<void>;
}

/**
 * bcrypt hashes in the `credentials` collection of the application's MongoDB
 * database, kept apart from the user documents. Plaintext passwords are
 * never stored.
 */
export class LocalAuthProvider implements AuthProvider {
  readonly name = 'local';
  // Compared against when the username is unknown, so that response time does
  // not reveal whether an account exists.
  private dummyHash: string;
  private rounds: number;

  constructor(rounds = 12) {
    this.rounds = rounds;
    this.dummyHash = bcrypt.hashSync('voluntrix-timing-equaliser', rounds);
  }

  async createIdentity(_email: string, password: string) {
    const cred = await Credential.create({ passwordHash: await bcrypt.hash(password, this.rounds) });
    return cred.id as string;
  }

  async verifyPassword(identity: { authId: string } | null, password: string) {
    const cred = identity ? await Credential.findById(identity.authId) : null;
    const ok = await bcrypt.compare(password, cred?.passwordHash ?? this.dummyHash);
    return Boolean(cred) && ok;
  }

  async deleteIdentity(authId: string) {
    await Credential.deleteOne({ _id: authId });
  }
}

export function createAuthProvider(): AuthProvider {
  return new LocalAuthProvider();
}
