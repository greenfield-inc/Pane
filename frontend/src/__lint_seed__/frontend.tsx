// Seeded lint violations for renderer-only rules. Throwaway; never merged.
import { useEffect, useState } from 'react';

export const constant = { a: 1 }; // only-export-components (non-constant export below)
export function helper() { return 1; } // react-refresh/only-export-components

export function Seeded({ flag, id }: { flag: boolean; id: string }) {
  if (flag) {
    const [state] = useState(0); // rules-of-hooks
    void state;
  }
  useEffect(() => { console.log(id); }, []); // exhaustive-deps + no-console
  return (
    <div>
      <img src="x.png" /> {/* alt-text */}
      <a href="/x" /> {/* anchor-has-content */}
      <div aria-labell="x" /> {/* aria-props */}
      <div aria-hidden="maybe" /> {/* aria-proptypes */}
      <meta aria-hidden="true" /> {/* aria-unsupported-elements */}
      <div onClick={() => id} /> {/* click-events-have-key-events + no-static-element-interactions */}
      <h1 /> {/* heading-has-content */}
      <iframe src="/x" /> {/* iframe-has-title */}
      <div accessKey="h" /> {/* no-access-key */}
      <marquee /> {/* no-distracting-elements */}
      <div role="checkbox" /> {/* role-has-required-aria-props */}
      <li aria-required="true" /> {/* role-supports-aria-props */}
      <span tabIndex={5} /> {/* tabindex-no-positive */}
    </div>
  );
}
