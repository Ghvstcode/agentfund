import { useEffect } from 'react';
import { useMeta } from '../api/queries';
import { APP_NAME } from '../config';

/** Set the tab title to "<page> · <instance name>". */
export function useDocumentTitle(page: string | undefined) {
  const instance = useMeta().data?.name ?? APP_NAME;
  useEffect(() => {
    document.title = page ? `${page} · ${instance}` : instance;
  }, [page, instance]);
}
