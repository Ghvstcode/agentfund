import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Settings, Shield, User } from 'lucide-react';
import { useNavigate } from 'react-router';
import { api } from '@/api/client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { session } from '@/lib/session';
import { UserPill } from './UserPill';

/** Account menu for the signed-in user. Loaded on demand: signed-out visitors never need it. */
export default function UserMenu({ handle, admin }: { handle: string; admin: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = async () => {
    await api.POST('/v1/auth/logout').catch(() => undefined);
    session.clear();
    queryClient.removeQueries({ queryKey: ['me'] });
    queryClient.removeQueries({ queryKey: ['admin'] });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <UserPill handle={handle} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Signed in as {handle}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate(`/u/${handle}`)}>
          <User strokeWidth={1.5} aria-hidden="true" /> Your profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigate('/settings')}>
          <Settings strokeWidth={1.5} aria-hidden="true" /> Settings
        </DropdownMenuItem>
        {admin && (
          <DropdownMenuItem onSelect={() => void navigate('/admin')}>
            <Shield strokeWidth={1.5} aria-hidden="true" /> Admin
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut strokeWidth={1.5} aria-hidden="true" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
