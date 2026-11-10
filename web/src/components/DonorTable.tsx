import type { DonorStanding } from '@/api/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Num } from './Num';
import { UserLink } from './UserLink';

interface DonorTableProps {
  donors: DonorStanding[];
  /** Accessible name of the table. */
  label: string;
  /** Rank of the first row, for tables that continue a podium above them. */
  startRank?: number;
}

const HEAD = 'h-10 text-[0.6875rem] font-medium tracking-[0.08em] text-muted-foreground uppercase';

/** Leaderboard rows, in the order given. The API ranks by delivered tokens. */
export function DonorTable({ donors, label, startRank = 1 }: DonorTableProps) {
  return (
    <Table aria-label={label} className="border-t border-t-foreground">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={cn(HEAD, 'w-14 pl-0')}>Rank</TableHead>
          <TableHead className={HEAD}>Donor</TableHead>
          <TableHead className={cn(HEAD, 'text-right')}>Delivered</TableHead>
          <TableHead className={cn(HEAD, 'text-right')}>Merged</TableHead>
          <TableHead className={cn(HEAD, 'hidden text-right md:table-cell')}>Reported</TableHead>
          <TableHead className={cn(HEAD, 'hidden text-right md:table-cell')}>Pledged</TableHead>
          <TableHead className={cn(HEAD, 'pr-0 text-right')}>Tasks</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="[&_tr:last-child]:border-b">
        {donors.map((donor, index) => (
          <TableRow key={donor.handle} className="h-16 hover:bg-muted/40">
            <TableCell className="num pl-0 text-[0.8125rem] text-muted-foreground">{String(startRank + index).padStart(2, '0')}</TableCell>
            <TableHead scope="row" className="h-auto py-3 font-normal text-foreground">
              <UserLink handle={donor.handle} avatar className="gap-3 text-[0.9375rem] font-semibold [&>span:first-child]:size-8 [&>span:first-child]:text-xs" />
            </TableHead>
            <TableCell className="text-right">
              <Num value={donor.delivered} className="text-[0.875rem] font-medium text-live" />
            </TableCell>
            <TableCell className="text-right">
              <Num value={donor.merged} className="text-[0.875rem]" />
            </TableCell>
            <TableCell className="hidden text-right text-muted-foreground md:table-cell">
              <Num value={donor.reported} className="text-[0.875rem]" />
            </TableCell>
            <TableCell className="hidden text-right text-muted-foreground md:table-cell">
              <Num value={donor.pledged} className="text-[0.875rem]" />
            </TableCell>
            <TableCell className="pr-0 text-right">
              <Num value={donor.tasks_delivered} unit="tasks delivered" className="text-[0.875rem]" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
