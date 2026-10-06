import { BookOpen, Compass, FolderGit2, KeyRound, LayoutDashboard, type LucideIcon, Palette, Shield, Trophy } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { flatItems, useDonors, useMe, useProjects } from '@/api/queries';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { HandleAvatar } from './HandleAvatar';
import { Num } from './Num';

const PAGES: { to: string; label: string; icon: LucideIcon; admin?: boolean }[] = [
  { to: '/', label: 'Discover projects', icon: Compass },
  { to: '/donors', label: 'Donor leaderboard', icon: Trophy },
  { to: '/maintain', label: 'Maintain your projects', icon: LayoutDashboard },
  { to: '/maintain/new', label: 'Register a project', icon: FolderGit2 },
  { to: '/settings', label: 'Settings and API keys', icon: KeyRound },
  { to: '/admin', label: 'Instance admin', icon: Shield, admin: true },
  { to: '/styleguide', label: 'Styleguide', icon: Palette },
];

/** ⌘K: jump to a page, a project or a donor. Loaded on first use. */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 150);
  const me = useMe();
  // The server searches projects; cmdk then filters whatever is on screen as you type.
  const projects = flatItems(useProjects({ q: q || undefined, limit: 8 }));
  const donors = flatItems(useDonors()).slice(0, 50);

  const go = (to: string) => {
    onClose();
    void navigate(to);
  };

  return (
    <CommandDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Go to"
      description="Jump to a page, a project or a donor"
      className="shadow-raised"
    >
      <Command>
      <CommandInput placeholder="Jump to a project, donor or page…" value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandEmpty>
          <BookOpen className="mx-auto mb-2 size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
          Nothing matches “{search}”.
        </CommandEmpty>
        {projects.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.map((project) => (
              <CommandItem key={project.slug} value={`project ${project.slug} ${project.name} ${project.description}`} onSelect={() => go(`/${project.slug}`)}>
                <FolderGit2 strokeWidth={1.5} aria-hidden="true" />
                <span className="flex-1 truncate">{project.name}</span>
                <span className="text-xs text-muted-foreground">
                  <Num value={project.totals.delivered} /> delivered
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {donors.length > 0 && (
          <CommandGroup heading="Donors">
            {donors.map((donor) => (
              <CommandItem key={donor.handle} value={`donor ${donor.handle}`} onSelect={() => go(`/u/${donor.handle}`)}>
                <HandleAvatar handle={donor.handle} className="size-4 text-[0.5rem]" />
                <span className="flex-1 truncate">{donor.handle}</span>
                <span className="text-xs text-muted-foreground">
                  <Num value={donor.delivered} /> delivered
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Pages">
          {PAGES.filter((page) => !page.admin || me.data?.role === 'admin').map((page) => (
            <CommandItem key={page.to} value={`page ${page.label}`} onSelect={() => go(page.to)}>
              <page.icon strokeWidth={1.5} aria-hidden="true" />
              {page.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
