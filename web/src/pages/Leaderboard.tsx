import { Trophy } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { flatItems, useDonors } from '@/api/queries';
import type { DonorStanding } from '@/api/types';
import { ButtonLink } from '@/components/Button';
import { DonorTable } from '@/components/DonorTable';
import { Handle } from '@/components/Handle';
import { HandleAvatar } from '@/components/HandleAvatar';
import { Num } from '@/components/Num';
import { EmptyState, ErrorState, Loading, LoadMore, SkeletonRows } from '@/components/States';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { formatCompact } from '@/lib/format';
import { isRemoteHandle, profilePath } from '@/lib/handles';
import { cn } from '@/lib/utils';

/** The first three donors, large: the board's headline. */
function Podium({ donors }: { donors: DonorStanding[] }) {
  return (
    <ol aria-label="Top donors" className="grid border-t border-b border-t-foreground md:grid-cols-3">
      {donors.map((donor, index) => (
        <li key={donor.handle} className={cn('relative grid content-start gap-5 border-b py-7 last:border-b-0 md:border-b-0', index > 0 && 'md:border-l md:pl-8', index < 2 && 'md:pr-8')}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <HandleAvatar handle={donor.handle} className="size-10 text-sm" />
              <div className="grid min-w-0">
                {/* The whole cell is the link target; the handle carries the accessible name. */}
                <Link
                  to={profilePath(donor.handle)}
                  aria-label={isRemoteHandle(donor.handle) ? donor.handle : undefined}
                  className="flex min-w-0 text-lg font-semibold tracking-[-0.02em] after:absolute after:inset-0 focus-visible:outline-none"
                >
                  <Handle handle={donor.handle} className="truncate" hostClassName="max-w-none sm:max-w-none" />
                </Link>
                <span className="num text-xs text-muted-foreground">
                  {donor.tasks_merged} merged · {donor.tasks_delivered} delivered
                </span>
              </div>
            </div>
            <span className={cn('num text-[1.75rem] leading-none font-medium tracking-[-0.03em]', index === 0 ? 'text-live' : 'text-muted-foreground')}>#{index + 1}</span>
          </div>
          <Num value={donor.delivered} className="text-5xl leading-none font-medium tracking-[-0.05em]" />
          <span className="num text-xs text-muted-foreground">{formatCompact(donor.merged)} of it merged</span>
        </li>
      ))}
    </ol>
  );
}

export default function Leaderboard() {
  useDocumentTitle('Leaderboard');
  const query = useDonors();
  const donors = flatItems(query);
  const podium = donors.slice(0, 3);
  const rest = donors.slice(3);

  return (
    <section className="container-page py-10 sm:py-12">
      <header className="rise mb-8 grid gap-3">
        <h1 className="text-[clamp(2.25rem,5vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.045em]">Leaderboard.</h1>
        <p className="max-w-2xl text-base text-pretty text-muted-foreground">
          Donors ranked by tokens delivered: inference that produced a pull request which passed CI. Pledges and failed
          runs are shown, and never move the ranking.
        </p>
      </header>
      <div className="rise grid gap-10" style={{ '--i': 1 } as CSSProperties}>
        {query.isPending ? (
          <Loading label="leaderboard">
            <SkeletonRows rows={10} />
          </Loading>
        ) : query.isError ? (
          <ErrorState title="Couldn't load the leaderboard" error={query.error} onRetry={() => void query.refetch()} />
        ) : donors.length === 0 ? (
          <EmptyState title="No donors yet" icon={Trophy} action={<ButtonLink to="/">Find a project to back</ButtonLink>}>
            <p>The board fills in as soon as someone pledges to a project or a worker reports its first run.</p>
          </EmptyState>
        ) : (
          <>
            <Podium donors={podium} />
            {rest.length > 0 && <DonorTable donors={rest} label="Donor leaderboard" startRank={4} />}
            <LoadMore
              hasMore={query.hasNextPage}
              loading={query.isFetchingNextPage}
              onLoad={() => void query.fetchNextPage()}
              label="More donors"
            />
          </>
        )}
      </div>
    </section>
  );
}
