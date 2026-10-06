import { Link } from 'react-router';

/** A donor handle linking to the public profile. System actors render as plain text. */
export function UserLink({ handle }: { handle: string }) {
  if (['system', 'ci', 'indexer'].includes(handle)) return <span className="actor">{handle}</span>;
  return (
    <Link to={`/u/${handle}`} className="user-link">
      {handle}
    </Link>
  );
}
