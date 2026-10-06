import { flatItems, useDonors } from '../api/queries';
import { ButtonLink } from '../components/Button';
import { DonorTable } from '../components/DonorTable';
import { EmptyState, ErrorState, Loading, LoadMore, SkeletonRows } from '../components/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export default function Leaderboard() {
  useDocumentTitle('Donors');
  const query = useDonors();
  const donors = flatItems(query);

  return (
    <section className="page">
      <header className="page__header">
        <h1>Donors</h1>
        <p className="lede">
          Ranked by delivered tokens: inference that produced a pull request which passed CI. Pledges and failed runs
          are shown, and never move the ranking.
        </p>
      </header>
      {query.isPending ? (
        <Loading label="leaderboard">
          <SkeletonRows rows={10} />
        </Loading>
      ) : query.isError ? (
        <ErrorState title="Couldn't load the leaderboard" error={query.error} onRetry={() => void query.refetch()} />
      ) : donors.length === 0 ? (
        <EmptyState title="No donors yet" action={<ButtonLink to="/">Find a project to back</ButtonLink>}>
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
    </section>
  );
}
