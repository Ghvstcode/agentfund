import type { DonorStanding } from '../api/types';
import { Num } from './Num';
import { TableScroll } from './TableScroll';
import { UserLink } from './UserLink';

interface DonorTableProps {
  donors: DonorStanding[];
  label: string;
}

/** Leaderboard rows, in the order given. The API ranks by delivered tokens. */
export function DonorTable({ donors, label }: DonorTableProps) {
  return (
    <TableScroll label={label}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col" className="table__rank">
              Rank
            </th>
            <th scope="col">Donor</th>
            <th scope="col" className="table__num">
              Delivered
            </th>
            <th scope="col" className="table__num">
              Merged
            </th>
            <th scope="col" className="table__num">
              Reported
            </th>
            <th scope="col" className="table__num">
              Pledged
            </th>
            <th scope="col" className="table__num">
              Tasks delivered
            </th>
          </tr>
        </thead>
        <tbody>
          {donors.map((donor, index) => (
            <tr key={donor.handle}>
              <td className="table__rank mono">{index + 1}</td>
              <th scope="row">
                <UserLink handle={donor.handle} />
              </th>
              <td className="table__num table__lead">
                <Num value={donor.delivered} />
              </td>
              <td className="table__num">
                <Num value={donor.merged} />
              </td>
              <td className="table__num">
                <Num value={donor.reported} />
              </td>
              <td className="table__num">
                <Num value={donor.pledged} />
              </td>
              <td className="table__num">
                <Num value={donor.tasks_delivered} unit="tasks" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
