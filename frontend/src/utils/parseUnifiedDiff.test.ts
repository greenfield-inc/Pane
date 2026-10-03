import { describe, it, expect } from 'vitest';
import { parseUnifiedDiffToFiles } from './parseUnifiedDiff';

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 context
-removed line
+added line
+another added
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+first
+second
`;

describe('parseUnifiedDiffToFiles', () => {
  it('returns nothing for empty input', () => {
    expect(parseUnifiedDiffToFiles('')).toEqual([]);
    expect(parseUnifiedDiffToFiles('   ')).toEqual([]);
    expect(parseUnifiedDiffToFiles('not a diff')).toEqual([]);
  });

  it('splits one entry per file and classifies the change', () => {
    const files = parseUnifiedDiffToFiles(SAMPLE);
    expect(files.map(f => f.path)).toEqual(['src/a.ts', 'src/new.ts']);
    expect(files[0].type).toBe('modified');
    expect(files[1].type).toBe('added');
  });

  it('counts changed lines without counting the +++/--- headers', () => {
    const files = parseUnifiedDiffToFiles(SAMPLE);
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[1].additions).toBe(2);
    expect(files[1].deletions).toBe(0);
  });

  it('detects deletions and renames', () => {
    const deleted = parseUnifiedDiffToFiles(
      'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n'
    );
    expect(deleted[0].type).toBe('deleted');
    expect(deleted[0].deletions).toBe(1);

    const renamed = parseUnifiedDiffToFiles(
      'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n'
    );
    expect(renamed[0].type).toBe('renamed');
    expect(renamed[0].oldPath).toBe('old.ts');
    expect(renamed[0].path).toBe('new.ts');
  });

  it('flags binary files', () => {
    const files = parseUnifiedDiffToFiles(
      'diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n'
    );
    expect(files[0].isBinary).toBe(true);
  });

  it('decodes Git-quoted non-ASCII paths for file reveal matching', () => {
    const files = parseUnifiedDiffToFiles(
      'diff --git "a/t\\303\\244st.txt" "b/t\\303\\244st.txt"\n--- "a/t\\303\\244st.txt"\n+++ "b/t\\303\\244st.txt"\n@@ -1 +1,2 @@\n old\n+new\n'
    );

    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe('täst.txt');
    expect(files[0].path).toBe('täst.txt');
  });

  it('handles a large diff without pathological cost', () => {
    // 50k added lines in one file — the shape that made Review crawl.
    const body = Array.from({ length: 50_000 }, (_, i) => `+line ${i}`).join('\n');
    const huge = `diff --git a/big.ts b/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,50000 @@\n${body}\n`;

    const started = performance.now();
    const files = parseUnifiedDiffToFiles(huge);
    const elapsed = performance.now() - started;

    expect(files).toHaveLength(1);
    expect(files[0].additions).toBe(50_000);
    // Generous bound: the point is that it is milliseconds, not seconds.
    expect(elapsed).toBeLessThan(1000);
  });
});
