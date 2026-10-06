import { ButtonLink } from '@/components/Button';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

/** The 404 page. `what` names the thing that was looked for, e.g. "a project called “x”". */
export default function NotFound({ what = 'that page' }: { what?: string }) {
  useDocumentTitle('Not found');
  return (
    <section className="container-page py-16 sm:py-24">
      <div className="rise mx-auto grid max-w-md gap-6">
        <p className="num text-7xl leading-none font-medium tracking-tighter text-muted-foreground sm:text-8xl" aria-hidden="true">
          404
        </p>
        <header className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Nothing here</h1>
          <p className="text-sm text-pretty text-muted-foreground">
            We looked for {what} and found nothing. The address may be mistyped, or it was removed from this instance.
          </p>
        </header>
        <div className="flex flex-wrap gap-2">
          <ButtonLink to="/" variant="primary">
            Browse projects
          </ButtonLink>
          <ButtonLink to="/donors">See the leaderboard</ButtonLink>
        </div>
      </div>
    </section>
  );
}
