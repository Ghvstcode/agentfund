import type { CSSProperties, ReactNode } from 'react';
import { useMeta } from '@/api/queries';
import { type LegalPage, LegalLink, useLegalHref } from '@/components/LegalLink';
import { APP_NAME } from '@/config';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { docLinks, instanceLinks } from '@/lib/commands';

/*
 * The built-in privacy policy and terms of use. They describe what the software does, which holds
 * for every instance; operator-specific facts (legal entity, hosting, governing law) are visible
 * placeholders. Operators with their own pages set PRIVACY_URL / TERMS_URL and these routes link
 * there instead.
 */

const UPDATED = '11 November 2026';

/** An operator- or lawyer-supplied detail that has not been filled in yet. */
function Fill({ children }: { children: ReactNode }) {
  return <span className="border border-dashed bg-muted/50 px-1 font-mono text-[0.8125rem] text-muted-foreground">[{children}]</span>;
}

function Section({ title, i, children }: { title: string; i: number; children: ReactNode }) {
  return (
    <section className="rise section-rule grid gap-4 pt-6 md:grid-cols-[14rem_1fr] md:gap-10" style={{ '--i': i } as CSSProperties}>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="grid max-w-[68ch] gap-4 text-[0.9375rem] leading-relaxed text-pretty [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:grid [&_ul]:list-disc [&_ul]:gap-2 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

function Contact() {
  const contact = instanceLinks(useMeta().data).legalContact;
  return contact ? (
    <a className="link" href={`mailto:${contact}`}>
      {contact}
    </a>
  ) : (
    <>the operator of this instance</>
  );
}

function Doc({ page, title, lede, children }: { page: LegalPage; title: string; lede: ReactNode; children: ReactNode }) {
  useDocumentTitle(title);
  const { href, external } = useLegalHref(page);
  if (external) {
    return (
      <section className="container-page py-16 sm:py-24">
        <div className="rise mx-auto grid max-w-md gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-pretty text-muted-foreground">
            This instance publishes its {title.toLowerCase()} at{' '}
            <a className="link break-all text-foreground" href={href} rel="noreferrer">
              {href}
            </a>
            .
          </p>
        </div>
      </section>
    );
  }
  return (
    <article className="container-page py-10 sm:py-12">
      <header className="rise mb-10 grid gap-3">
        <h1 className="text-[clamp(2.25rem,5vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.045em]">{title}.</h1>
        <p className="max-w-2xl text-base text-pretty text-muted-foreground">{lede}</p>
        <p className="label">Last updated {UPDATED}</p>
      </header>
      <div className="grid gap-10">{children}</div>
    </article>
  );
}

export function Privacy() {
  const meta = useMeta().data;
  const name = meta?.name ?? APP_NAME;
  const security = docLinks(meta).security;
  return (
    <Doc
      page="privacy"
      title="Privacy policy"
      lede={
        <>
          What {name} collects, what it publishes, and what it never sees. {name} is run by{' '}
          <Fill>OPERATOR LEGAL NAME</Fill> (“the operator”, “we”) on AgentFund, open-source software that lets backers
          donate coding-agent time to open-source projects.
        </>
      }
    >
      <Section title="The short version" i={1}>
        <ul>
          <li>You sign in with GitHub. We keep your GitHub username, numeric ID, avatar address and email address.</li>
          <li>
            <strong>Your email address is never public.</strong> Your handle, and the tokens you pledge and deliver, are
            public by design: the public ledger is the point of the service.
          </li>
          <li>
            <strong>Your model credentials never reach us.</strong> The worker runs on your machine with your own coding
            agent account, and it never sends that credential to this instance.
          </li>
          <li>We do not sell data, show ads, or use analytics or tracking cookies.</li>
        </ul>
      </Section>

      <Section title="What we collect and why" i={2}>
        <p>
          <strong>Your account.</strong> Signing in asks GitHub for read-only access to your profile and email addresses
          (the <code>read:user</code> and <code>user:email</code> scopes). We store your GitHub user ID, username, avatar
          address and one email address: the public one on your profile or, if there isn’t one, your primary verified
          address, which may be private on GitHub. We also store your handle on this instance, your role, whether the
          account is banned, and when you joined. We use this to identify you, keep one account per GitHub user,
          moderate the instance, and contact you about your account. We send no newsletters. GitHub’s access token is
          used once, to read your profile during sign-in, and then discarded. It is never stored.
        </p>
        <p>
          <strong>Sessions and worker keys.</strong> Browser sessions and the API keys you create for the worker are
          stored only as SHA-256 hashes. For each key we keep its label, its first characters, when it was created, when
          it was last used (to the minute), and whether it was revoked. Sessions record when they started and when they
          expire.
        </p>
        <p>
          <strong>Pledges and runs.</strong> We record your pledges (project, amount, time) and every task you claim.
          While a task runs, the worker sends heartbeats with running token counts and its current phase. When it
          finishes, it sends a report with the outcome, input and output token counts, an estimated API-equivalent
          cost, the branch, pull request link and commit it pushed, the exit code of the project’s checks, how long the
          run took, the names of the agent and model, a short status message, and a SHA-256 digest of the run log.
          The log itself, the prompt and the agent’s output stay on your machine. If you abandon a run, we record the
          tokens it used.
        </p>
        <p>
          <strong>Projects.</strong> For a registered project we store its name, description, repository and homepage
          addresses, tags, maintainer, the maintainer’s public signing key, the signed task files read from the
          repository, and a webhook secret. We clone the project’s repository to read its tasks, and we receive CI
          results from GitHub or the project’s CI: run links, outcomes, branches and commits.
        </p>
        <p>
          <strong>Audit log.</strong> Every change of state (a project registered, a task claimed, a report filed, a
          project paused or removed) is written to an append-only log with the handle that caused it and the time.
        </p>
        <p>
          <strong>Technical data.</strong> Our request log records the method, path, status code and duration of each
          request. It does not record your IP address, the query string or your browser. To rate-limit requests we
          hold your IP address in memory for at most a minute and never write it down. The worker identifies its
          version in a User-Agent header.
        </p>
      </Section>

      <Section title="What is public" i={3}>
        <p>Anyone can see the following, without signing in, on this site, through the public API and in the Atom feed:</p>
        <ul>
          <li>your handle, GitHub username, join date and profile page;</li>
          <li>your pledges, the tokens you delivered and had merged, your rank on the leaderboard, your streak and the projects you back;</li>
          <li>
            each run you report: the task, its outcome, token counts, cost estimate, agent and model names, duration,
            branch, pull request link, commit and status message;
          </li>
          <li>audit log entries that name your handle;</li>
          <li>if you maintain a project, the project and its tasks.</li>
        </ul>
        <p>
          Your email address, sessions and keys are not public. You can see your email address in Settings, and the
          instance’s admins can see it to moderate the instance. Pull requests are opened on GitHub under your own
          GitHub account, so GitHub’s terms and privacy statement cover them.
        </p>
      </Section>

      <Section title="What we never receive" i={4}>
        <ul>
          <li>your model provider credential, such as a subscription token from <code>claude setup-token</code> or an API key;</li>
          <li>a GitHub token that outlives sign-in, or any token that can write to your repositories;</li>
          <li>your prompts, the agent’s transcript, or the run log, beyond its digest;</li>
          <li>your Git credentials. The worker pushes and opens pull requests with your own <code>gh</code> login, on your machine.</li>
        </ul>
      </Section>

      <Section title="Cookies and browser storage" i={5}>
        <p>
          This site sets no cookies of its own. It keeps four things in your browser’s storage: your session token, your
          light or dark theme, how you like the task list shown, and, for the length of a sign-in, the page to return to.
          Signing out deletes the session token. Fonts are served from this site, and no third-party scripts or analytics
          load.
        </p>
        <p>
          The network provider in front of this instance may set cookies that are strictly needed for security and to
          block abuse. <Fill>OPERATOR: name the provider, or remove this paragraph</Fill>
        </p>
      </Section>

      <Section title="Who else processes data" i={6}>
        <ul>
          <li>
            <strong>GitHub</strong> handles sign-in, and we read public repository and CI data from it. GitHub’s privacy
            statement covers your GitHub account.
          </li>
          <li>
            <strong>Your model provider.</strong> Your worker talks to it directly under your own account. This instance
            has no relationship with it and sends it nothing.
          </li>
          <li>
            <strong>Hosting.</strong> <Fill>OPERATOR: list the hosting, database and CDN providers, what each sees, and where they process data</Fill>
          </li>
        </ul>
        <p>We do not sell or rent personal data or share it with advertisers or data brokers.</p>
      </Section>

      <Section title="How long we keep it" i={7}>
        <ul>
          <li>Account details: for as long as the account exists.</li>
          <li>
            Sessions expire after a period the operator sets, 30 days by default. Revoked and expired session records
            stay with the account.
          </li>
          <li>Sign-in state: ten minutes.</li>
          <li>
            Pledges, reports, CI results and the audit log: permanently. The audit log is append-only by design. It is
            what lets anyone check the accounting.
          </li>
          <li>
            Server logs and backups: <Fill>OPERATOR: retention at the hosting provider</Fill>
          </li>
        </ul>
      </Section>

      <Section title="Your choices and requests" i={8}>
        <ul>
          <li>Settings shows your profile, email address and keys. You can revoke a key or sign out at any time.</li>
          <li>Your public data is on your profile page and in the public API.</li>
          <li>
            <strong>Export.</strong> Write to <Contact /> and we will send you a copy of what we hold about you as JSON.
          </li>
          <li>
            <strong>Correction.</strong> Change your GitHub profile; we pick the change up the next time you sign in.
          </li>
          <li>
            <strong>Deletion.</strong> Write to <Contact />. We will remove your email address, GitHub ID and avatar,
            revoke your sessions and keys, and close the account. Entries in the public ledger and audit log cannot be
            removed and will keep showing your handle: the log is append-only, and the accounting of every project
            depends on it.
          </li>
        </ul>
        <p>
          Depending on where you live, data protection law may give you further rights, such as to access, restrict or
          object to processing, and to complain to a supervisory authority.{' '}
          <Fill>LAWYER: legal bases for processing, data controller, international transfers, and whether the deletion limits above are compatible with applicable law</Fill>
        </p>
        <p>
          The service is not meant for children. You need to be old enough to hold a GitHub account and to accept the
          terms of use where you live.
        </p>
      </Section>

      <Section title="Security" i={9}>
        <p>
          Tokens and keys are stored as hashes, the server holds no credential for anyone’s GitHub or model provider, and
          tasks run in a sandbox on the backer’s machine. Our{' '}
          <a className="link" href={security} rel="noreferrer">
            security model
          </a>{' '}
          explains what this protects and what it does not, and how to report a vulnerability.
        </p>
      </Section>

      <Section title="Changes" i={10}>
        <p>
          When this policy changes we will update it here and change the date at the top. We will announce material
          changes on the site before they take effect.
        </p>
      </Section>

      <Section title="Contact" i={11}>
        <p>
          Write to <Contact /> with questions or requests. Operator: <Fill>OPERATOR LEGAL NAME AND POSTAL ADDRESS</Fill>
        </p>
      </Section>
    </Doc>
  );
}

export function Terms() {
  const meta = useMeta().data;
  const name = meta?.name ?? APP_NAME;
  const links = instanceLinks(meta);
  const docs = docLinks(meta);
  return (
    <Doc
      page="terms"
      title="Terms of use"
      lede={
        <>
          The rules for using {name}
          {meta?.base_url && <> at {meta.base_url}</>}. They are an agreement between you and{' '}
          <Fill>OPERATOR LEGAL NAME</Fill> (“the operator”, “we”). By signing in, or by pointing a worker or other client at
          this instance, you accept them.
        </>
      }
    >
      <Section title="The service and the software" i={1}>
        <p>
          {name} runs AgentFund, which is open-source software licensed under the{' '}
          <a className="link" href={`${links.sourceUrl.replace(/\/+$/, '')}/blob/HEAD/LICENSE`} rel="noreferrer">
            Apache License 2.0
          </a>
          . That licence governs the code. These terms govern only this instance, the service we run. If you run your
          own instance, these terms do not apply to it, and you set your own.
        </p>
      </Section>

      <Section title="Your account" i={2}>
        <ul>
          <li>You sign in with GitHub, and you must follow GitHub’s terms.</li>
          <li>
            Keep your worker keys secret. You are responsible for what is done with your account and keys. Revoke a key
            in Settings if it leaks.
          </li>
          <li>
            What you do here is public by design. The{' '}
            <LegalLink page="privacy" className="link">
              privacy policy
            </LegalLink>{' '}
            lists what is shown.
          </li>
        </ul>
      </Section>

      <Section title="Backers" i={3}>
        <ul>
          <li>
            You donate by running the worker on your own machine with your own coding-agent account. This instance never
            receives that credential, and you pay your provider directly.
          </li>
          <li>
            <strong>You are responsible for following your model provider’s terms</strong>, usage policies and plan
            limits, including whether your plan allows this use. AgentFund’s documented setup uses a subscription token
            from <code>claude setup-token</code>. We make no statement about what any provider’s terms allow. Read them
            yourself.
          </li>
          <li>
            You choose which projects to back. Tasks are signed by their maintainer, you review and approve a project
            before the worker runs it, and runs happen in a sandbox on your machine. You remain responsible for your
            machine and for what you approve.
          </li>
          <li>
            A pledge is a statement of intent, not a payment. No money changes hands through this instance, and token
            figures have no monetary value here.
          </li>
          <li>
            Pull requests are opened under your own GitHub account. GitHub’s terms and the project’s contribution rules
            (its licence, and any CLA or sign-off it asks for) apply to them.
          </li>
        </ul>
      </Section>

      <Section title="Maintainers" i={4}>
        <ul>
          <li>Register only repositories you are allowed to maintain.</li>
          <li>
            <strong>You are responsible for your tasks</strong>: their prompts, their checks, and whatever they lead a
            backer’s agent to do. A task must not tell an agent to cause harm, take data, attack systems, or break the law
            or anyone’s rights.
          </li>
          <li>You decide what to merge. Neither we nor the backers promise that any pull request is correct or useful.</li>
        </ul>
      </Section>

      <Section title="Acceptable use" i={5}>
        <p>Do not use {name} to:</p>
        <ul>
          <li>break the law, or infringe anyone’s rights, including intellectual property and privacy;</li>
          <li>distribute malware, or attack, probe or overload this instance or anyone else’s systems;</li>
          <li>game the ledger, for example with invented reports, inflated token counts or accounts made to boost a ranking;</li>
          <li>impersonate others, spam, or harass anyone;</li>
          <li>break the terms of a third party, including GitHub and your model provider.</li>
        </ul>
        <p>
          Our{' '}
          <a className="link" href={`${links.sourceUrl.replace(/\/+$/, '')}/blob/HEAD/CODE_OF_CONDUCT.md`} rel="noreferrer">
            code of conduct
          </a>{' '}
          applies too.
        </p>
      </Section>

      <Section title="Moderation" i={6}>
        <p>
          The instance’s admins may pause or remove a project, and ban an account, when they believe it breaks
          these terms or puts backers at risk. They may do so without notice where safety calls for it. Pausing or removing
          a project is recorded in the public audit log. To appeal, write to <Contact />.
        </p>
      </Section>

      <Section title="No warranty" i={7}>
        <p>
          {name} is provided “as is” and “as available”, without warranties of any kind, express or implied, including
          fitness for a particular purpose. It is young software. It may be unavailable, lose data or get things wrong. We
          are not responsible for model usage you spend, for the quality of any pull request, or for action your model
          provider takes on your account.
        </p>
        <p>
          <Fill>LAWYER: limitation of liability and indemnity</Fill>
        </p>
      </Section>

      <Section title="Ending" i={8}>
        <p>
          You can stop using {name} at any time, and ask us to close your account (see the privacy policy). We may suspend
          or end your access for a breach of these terms, and we may change or shut down the service. Public ledger entries
          remain after an account closes.
        </p>
      </Section>

      <Section title="Changes" i={9}>
        <p>
          We may update these terms. We will post the new version here with a new date and announce material changes on
          the site before they take effect. Continuing to use {name} after that means you accept them.
        </p>
      </Section>

      <Section title="Governing law" i={10}>
        <p>
          <Fill>LAWYER: governing law, jurisdiction and courts</Fill>
        </p>
      </Section>

      <Section title="Contact" i={11}>
        <p>
          Write to <Contact /> with questions about these terms. The docs for{' '}
          <a className="link" href={docs.donors} rel="noreferrer">
            backers
          </a>{' '}
          and{' '}
          <a className="link" href={docs.maintainers} rel="noreferrer">
            maintainers
          </a>{' '}
          explain how the service works.
        </p>
      </Section>
    </Doc>
  );
}
