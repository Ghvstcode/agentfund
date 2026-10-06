import { Link } from 'react-router';
import type { Project } from '../api/types';
import { formatPercent } from '../lib/format';
import { Badge } from './Badge';
import { FundingBar } from './FundingBar';
import { Num } from './Num';
import { Skeleton } from './States';

function taskSummary(tasks: Project['tasks']): string {
  const parts = [
    tasks.open > 0 && `${tasks.open} open`,
    tasks.claimed > 0 && `${tasks.claimed} in progress`,
    tasks.delivered > 0 && `${tasks.delivered} delivered`,
    tasks.merged > 0 && `${tasks.merged} merged`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No tasks yet';
}

export function ProjectCard({ project }: { project: Project }) {
  const { totals, tasks } = project;
  return (
    <article className="project-card">
      <header className="project-card__header">
        <h3 className="project-card__name">
          <Link to={`/${project.slug}`}>{project.name}</Link>
        </h3>
        {totals.in_flight > 0 ? (
          <Badge tone="live">Running now</Badge>
        ) : project.status === 'paused' ? (
          <Badge>Paused</Badge>
        ) : (
          (tasks.claimable ?? 0) > 0 && <Badge>Needs donors</Badge>
        )}
      </header>
      <p className="project-card__description">{project.description}</p>
      <div className="project-card__funding">
        <div className="project-card__figures">
          <span>
            <Num value={totals.delivered} /> <span className="muted">delivered</span>
          </span>
          <span className="muted">
            <span className="mono">{formatPercent(totals.delivered, project.token_goal)}</span> of{' '}
            <Num value={project.token_goal} />
          </span>
        </div>
        <FundingBar totals={totals} goal={project.token_goal} />
        <p className="project-card__pledged muted">
          <Num value={totals.pledged} /> pledged · <Num value={totals.merged} /> merged
        </p>
      </div>
      <footer className="project-card__footer">
        <ul className="tag-list" aria-label="Language and tags">
          {project.language && <li className="tag tag--language">{project.language}</li>}
          {project.tags?.map((tag) => (
            <li key={tag} className="tag">
              {tag}
            </li>
          ))}
        </ul>
        <p className="project-card__tasks muted">{taskSummary(tasks)}</p>
      </footer>
    </article>
  );
}

export function ProjectCardSkeleton() {
  return (
    <div className="project-card" aria-hidden="true">
      <Skeleton width="40%" height="1.375rem" />
      <Skeleton width="85%" height="1.4rem" />
      <div className="project-card__funding">
        <Skeleton width="55%" height="1.4rem" />
        <Skeleton height="0.5rem" />
        <Skeleton width="45%" height="1.2rem" />
      </div>
      <Skeleton width="70%" height="1.4rem" />
    </div>
  );
}
