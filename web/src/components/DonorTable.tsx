import type { DonorStanding } from '@/api/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Num } from './Num';
import { UserLink } from './UserLink';

interface DonorTableProps {
  donors: DonorStanding[];
  /** Accessible name of the table. */
  label: string;
}

/** Leaderboard rows, in the order given. The API ranks by delivered tokens. */
export function DonorTable({ donors, label }: DonorTableProps) {
  const top = Math.max(1, donors[0]?.delivered ?? 0);
  return (
    <div className="surface overflow-hidden">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-14 pl-5">Rank</TableHead>
            <TableHead>Donor</TableHead>
            <TableHead className="text-right">Delivered</TableHead>
            <TableHead className="hidden w-40 sm:table-cell">
              <span className="sr-only">Share of the leader</span>
            </TableHead>
            <TableHead className="text-right">Merged</TableHead>
            <TableHead className="hidden text-right md:table-cell">Reported</TableHead>
            <TableHead className="hidden text-right md:table-cell">Pledged</TableHead>
            <TableHead className="pr-5 text-right">Tasks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {donors.map((donor, index) => (
            <TableRow key={donor.handle} className="hover:bg-muted/40">
              <TableCell className={cn('num pl-5 text-muted-foreground', index < 3 && 'font-medium text-foreground')}>{index + 1}</TableCell>
              <TableHead scope="row" className="h-auto py-2.5 font-normal text-foreground">
                <UserLink handle={donor.handle} avatar />
              </TableHead>
              <TableCell className="text-right font-medium">
                <Num value={donor.delivered} />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <span className="block h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <span className="block h-full rounded-full bg-foreground" style={{ width: `${(donor.delivered / top) * 100}%` }} />
                </span>
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                <Num value={donor.merged} />
              </TableCell>
              <TableCell className="hidden text-right text-muted-foreground md:table-cell">
                <Num value={donor.reported} />
              </TableCell>
              <TableCell className="hidden text-right text-muted-foreground md:table-cell">
                <Num value={donor.pledged} />
              </TableCell>
              <TableCell className="pr-5 text-right text-muted-foreground">
                <Num value={donor.tasks_delivered} unit="tasks delivered" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
