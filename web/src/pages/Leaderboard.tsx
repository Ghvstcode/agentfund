import { Trophy } from 'lucide-react';
import type { CSSProperties } from 'react';
import { flatItems, useDonors } from '@/api/queries';
import { ButtonLink } from '@/components/Button';
import { DonorTable } from '@/components/DonorTable';
import { EmptyState, ErrorState, Loading, LoadMore, SkeletonRows } from '@/components/States';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

export default function Leaderboard() {
  useDocumentTitle('Donors');
  const query = useDonors();
  const donors = flatItems(query);

  return (
    <section className="container-page py-10">
      <header className="rise mb-8 grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Donors</h1>
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">
          Ranked by delivered tokens: inference that produced a pull request which passed CI. Pledges and failed runs
          are shown, and never move the ranking.
        </p>
      </header>
      <div className="rise" style={{ '--i': 1 } as CSSProperties}>
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
            <DonorTable donors={donors} label="Donor leaderboard" />
            <LoadMore
              hasMore={query.hasNextPage}
              loading={query.isFetchingNextPage}
              onLoad={() => void query.fetchNextPage()}
              label="Load more donors"
            />
          </>
        )}
      </div>
    </section>
  );
}
