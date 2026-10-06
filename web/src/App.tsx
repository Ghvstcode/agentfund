import { lazy } from 'react';
import { Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import Discover from './pages/Discover';
import NotFound from './pages/NotFound';

// Discover ships in the main bundle. The project page is one on-demand chunk (its tabs load
// together, so switching between them is instant); every other page is its own chunk.
const project = () => import('./pages/project');
const ProjectPage = lazy(() => project().then((module) => ({ default: module.ProjectPage })));
const TasksTab = lazy(() => project().then((module) => ({ default: module.TasksTab })));
const ActivityTab = lazy(() => project().then((module) => ({ default: module.ActivityTab })));
const DonorsTab = lazy(() => project().then((module) => ({ default: module.DonorsTab })));
const AuditTab = lazy(() => project().then((module) => ({ default: module.AuditTab })));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const DonorProfile = lazy(() => import('./pages/DonorProfile'));
const Maintain = lazy(() => import('./pages/Maintain'));
const ProjectWizard = lazy(() => import('./pages/ProjectWizard'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const Styleguide = lazy(() => import('./pages/Styleguide'));
const AuthCallback = lazy(() => import('./pages/AuthCallback'));

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Discover />} />
        <Route path="donors" element={<Leaderboard />} />
        <Route path="u/:handle" element={<DonorProfile />} />
        <Route path="maintain" element={<Maintain />} />
        <Route path="maintain/new" element={<ProjectWizard />} />
        <Route path="settings" element={<Settings />} />
        <Route path="admin/:section?" element={<Admin />} />
        <Route path="styleguide/*" element={<Styleguide />} />
        <Route path="auth/callback" element={<AuthCallback />} />
        <Route path=":slug" element={<ProjectPage />}>
          <Route index element={<TasksTab />} />
          <Route path="tasks/:taskId" element={<TasksTab />} />
          <Route path="activity" element={<ActivityTab />} />
          <Route path="donors" element={<DonorsTab />} />
          <Route path="audit" element={<AuditTab />} />
          <Route path="*" element={<NotFound what="that section of the project" />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
