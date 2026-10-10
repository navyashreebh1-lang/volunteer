import type { ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { Role } from './api';
import { homeFor, useAuth } from './auth';
import { Logo, Spinner } from './components';
import { FacultyPage } from './pages/Faculty';
import { LoginPage } from './pages/Login';
import { RegisterPage } from './pages/Register';
import { EventDetailPage, EventsPage } from './pages/manage/Events';
import { ManageAssignmentsPage, ManagerDashboard, VolunteersPage } from './pages/manage/ManagePages';
import { ProfilePage } from './pages/student/Profile';
import { PerformancePage, QuestionsPage } from './pages/manage/Performance';
import { ActivitiesPage, AssignmentsPage, NotificationsPage, SchedulePage, StudentDashboard } from './pages/student/StudentPages';
import { AttemptPage, FeedbackPage, StudentLeaderboardPage, TestsPage } from './pages/student/Tests';

const ROLE_NAMES: Record<Role, string> = { student: 'Student', faculty: 'Faculty', organizer: 'Organizer' };

const NAV: Record<Role, { to: string; label: string; end?: boolean }[]> = {
  student: [
    { to: '/student', label: 'Dashboard', end: true },
    { to: '/student/profile', label: 'My Profile' },
    { to: '/student/skills', label: 'My Skills' },
    { to: '/student/availability', label: 'My Availability' },
    { to: '/student/tests', label: 'Mock Tests' },
    { to: '/student/leaderboard', label: 'Leaderboard' },
    { to: '/student/activities', label: 'Available Activities' },
    { to: '/student/assignments', label: 'My Assignments' },
    { to: '/student/schedule', label: 'My Schedule' },
    { to: '/student/feedback', label: 'My Feedback' },
    { to: '/student/notifications', label: 'Notifications' },
  ],
  faculty: [
    { to: '/faculty', label: 'Dashboard', end: true },
    { to: '/manage/events', label: 'Events' },
    { to: '/manage/volunteers', label: 'Volunteers' },
    { to: '/manage/assignments', label: 'Assignments' },
    { to: '/manage/performance', label: 'Performance' },
    { to: '/faculty/questions', label: 'Question Bank' },
    { to: '/faculty/promotions', label: 'Promotions' },
    { to: '/manage/notifications', label: 'Notifications' },
  ],
  organizer: [
    { to: '/organizer', label: 'Dashboard', end: true },
    { to: '/manage/events', label: 'My Events' },
    { to: '/manage/volunteers', label: 'Volunteers' },
    { to: '/manage/assignments', label: 'Assignments' },
    { to: '/manage/performance', label: 'Performance' },
    { to: '/manage/notifications', label: 'Notifications' },
  ],
};

/**
 * Routing convenience only. Every API these pages call checks the session
 * and role again on the server, which is where access is actually enforced.
 */
function Protected({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Checking your session…" />;
  if (!me) return <Navigate to="/login" replace />;
  if (!roles.includes(me.user.role)) return <Navigate to={homeFor(me.user.role)} replace />;

  // A student sets up their volunteer profile before anything else. Faculty
  // and organizers are never sent to that form.
  const setupPaths = ['/student/profile', '/student/skills', '/student/availability'];
  if (me.user.role === 'student' && !me.studentProfile?.profileComplete && !setupPaths.includes(location.pathname)) {
    return <Navigate to="/student/profile" replace />;
  }
  return <Shell>{children}</Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  const setupPending = me.user.role === 'student' && !me.studentProfile?.profileComplete;

  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="shell">
      <header className="topbar">
        <Logo />
        <div className="topbar-user">
          <span className="topbar-name">
            {me.user.fullName}
            <span className={`role-chip role-chip-${me.user.role}`}>{ROLE_NAMES[me.user.role]}</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <div className="shell-body">
        {!setupPending && (
          <nav className="sidenav" aria-label="Main">
            {NAV[me.user.role].map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `sidenav-link${isActive ? ' sidenav-link-active' : ''}`}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}
        <main className="shell-main">{children}</main>
      </div>
    </div>
  );
}

function Home() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner label="Checking your session…" />;
  return <Navigate to={me ? homeFor(me.user.role) : '/login'} replace />;
}

const student = (page: ReactNode) => <Protected roles={['student']}>{page}</Protected>;
const manager = (page: ReactNode) => <Protected roles={['faculty', 'organizer']}>{page}</Protected>;

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route path="/student" element={student(<StudentDashboard />)} />
      <Route path="/student/profile" element={student(<ProfilePage />)} />
      <Route path="/student/skills" element={student(<ProfilePage focus="skills" />)} />
      <Route path="/student/availability" element={student(<ProfilePage focus="availability" />)} />
      <Route path="/student/activities" element={student(<ActivitiesPage />)} />
      <Route path="/student/assignments" element={student(<AssignmentsPage />)} />
      <Route path="/student/schedule" element={student(<SchedulePage />)} />
      <Route path="/student/notifications" element={student(<NotificationsPage />)} />
      <Route path="/student/tests" element={student(<TestsPage />)} />
      <Route path="/student/tests/:id" element={student(<AttemptPage />)} />
      <Route path="/student/leaderboard" element={student(<StudentLeaderboardPage />)} />
      <Route path="/student/feedback" element={student(<FeedbackPage />)} />

      <Route path="/faculty" element={<Protected roles={['faculty']}><ManagerDashboard /></Protected>} />
      <Route path="/faculty/promotions" element={<Protected roles={['faculty']}><FacultyPage /></Protected>} />
      <Route path="/organizer" element={<Protected roles={['organizer']}><ManagerDashboard /></Protected>} />
      <Route path="/manage/events" element={manager(<EventsPage />)} />
      <Route path="/manage/events/:id" element={manager(<EventDetailPage />)} />
      <Route path="/manage/volunteers" element={manager(<VolunteersPage />)} />
      <Route path="/manage/assignments" element={manager(<ManageAssignmentsPage />)} />
      <Route path="/manage/notifications" element={manager(<NotificationsPage />)} />
      <Route path="/manage/performance" element={manager(<PerformancePage />)} />
      <Route path="/faculty/questions" element={<Protected roles={['faculty']}><QuestionsPage /></Protected>} />

      <Route path="*" element={<Home />} />
    </Routes>
  );
}
