import { type RefObject, useEffect, useState } from 'react';

/** True once the element has scrolled into (or near) the viewport; it then stays true. */
export function useInView(ref: RefObject<Element | null>, rootMargin = '200px'): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}
