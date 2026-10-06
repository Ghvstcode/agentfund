import { Users } from 'lucide-react';
import { useLedger } from '@/api/queries';
import { DonorTable } from '@/components/DonorTable';
import { EmptyState, ErrorState, Loading, SkeletonRows } from '@/components/States';
import { useProjectContext } from './ProjectPage';

export default function DonorsTab() {
  const { project } = useProjectContext();
  const ledger = useLedger(project.slug);
  // The full leaderboard rides along with every ledger page; the first one is enough.
  const donors = ledger.data?.pages[0]?.donors ?? [];

  return (
    <section aria-labelledby="donors-title" className="grid min-w-0 gap-3">
      <h2 id="donors-title" className="sr-only">
        Donors
      </h2>
      {ledger.isPending ? (
        <Loading label="donors">
          <SkeletonRows rows={5} />
        </Loading>
      ) : ledger.isError ? (
        <ErrorState title="Couldn't load donors" error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : donors.length === 0 ? (
        <EmptyState icon={Users} title="No donors yet">
          <p>
            Nobody has pledged to or worked on {project.name} so far. Use “Back with tokens” above to be the first name
            on this board.
          </p>
        </EmptyState>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Ranked by delivered tokens: runs whose pull request passed CI.</p>
          <DonorTable donors={donors} label={`Donors to ${project.name}`} />
        </>
      )}
    </section>
  );
}
