const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['js', 'javascript'], ['jsx', 'javascript'], ['ts', 'typescript'], ['tsx', 'typescript'],
  ['json', 'json'], ['jsonl', 'json'], ['ndjson', 'json'], ['ipynb', 'json'], ['md', 'markdown'], ['py', 'python'], ['rb', 'ruby'],
  ['go', 'go'], ['rs', 'rust'], ['cpp', 'cpp'], ['c', 'c'], ['h', 'c'], ['hpp', 'cpp'],
  ['java', 'java'], ['cs', 'csharp'], ['php', 'php'], ['html', 'html'], ['css', 'css'],
  ['scss', 'scss'], ['sass', 'sass'], ['less', 'less'], ['xml', 'xml'], ['yaml', 'yaml'],
  ['yml', 'yaml'], ['toml', 'ini'], ['ini', 'ini'], ['sh', 'shell'], ['bash', 'shell'],
  ['zsh', 'shell'], ['fish', 'shell'], ['ps1', 'powershell'], ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'], ['sql', 'sql'], ['graphql', 'graphql'], ['vue', 'vue'],
  ['svelte', 'svelte'],
]);

export function fileExtension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? '';
}

export function getLanguageFromPath(filePath: string): string {
  return LANGUAGE_BY_EXTENSION.get(fileExtension(filePath)) ?? 'plaintext';
}
