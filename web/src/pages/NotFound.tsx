import { ButtonLink } from '../components/Button';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/** The 404 page. `what` names the thing that was looked for, e.g. "a project called “x”". */
export default function NotFound({ what = 'that page' }: { what?: string }) {
  useDocumentTitle('Not found');
  return (
    <section className="page page--narrow not-found">
      <p className="not-found__code mono" aria-hidden="true">
        404
      </p>
      <header className="page__header">
        <h1>Nothing here</h1>
        <p className="lede">
          We looked for {what} and found nothing. The address may be mistyped, or it was removed from this instance.
        </p>
      </header>
      <div className="button-row">
        <ButtonLink to="/" variant="primary">
          Browse projects
        </ButtonLink>
        <ButtonLink to="/donors">See the leaderboard</ButtonLink>
      </div>
    </section>
  );
}
