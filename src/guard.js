/**
 * guard.js — which shell commands need an approval first.
 *
 * Deliberately not strict: only what cannot be undone and is easy to get wrong.
 *  - recursive delete (rm -r/-R/-rf) when a target is /, the home folder or one of its ancestors, or a path variable
 *    that may be empty (rm -rf $X, rm -rf ${X}/);
 *  - git clean -f (without -n) and git reset --hard;
 *  - mkfs*, dd writing to a device, and the classic fork bomb.
 * Everything else runs (rm -rf build, rm -rf $W/build, single files). The agent asks with request_approval, the owner
 * decides, the same command then goes through.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

const SEPARATORS = new Set(['&&', '||', ';', '|']);
const FORK_BOMB = /:\(\)\s*\{\s*:\|:&\s*\};:/;

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
const ancestorOrSame = (anc, p) => p === anc || p.startsWith(anc.replace(/\/+$/, '') + '/');

/** POSIX-ish split: quotes, backslash; separators become their own tokens. null when a quote is open. */
export function split(command) {
  const tokens = [];
  let cur = '';
  let has = false;
  let q = null;
  const s = String(command ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) tokens.push(cur);
      cur = '';
      has = false;
    } else if (c === ';' || c === '|' || c === '&') {
      if (has || cur) tokens.push(cur);
      cur = '';
      has = false;
      if ((c === '|' || c === '&') && s[i + 1] === c) {
        tokens.push(c + c);
        i++;
      } else tokens.push(c === '&' ? ';' : c);
    } else cur += c;
  }
  if (q) return null;
  if (has || cur) tokens.push(cur);
  return tokens;
}

function segments(command) {
  const tokens = split(command);
  if (!tokens) return [[String(command ?? '')]];
  const out = [[]];
  for (const t of tokens) {
    if (SEPARATORS.has(t)) out.push([]);
    else out[out.length - 1].push(t);
  }
  return out.filter((x) => x.length);
}

export function makeGuard({ home = homedir() } = {}) {
  const HOME = real(home);
  const expandHome = (t) => (t === '~' || t.startsWith('~/') ? HOME + t.slice(1) : t.replaceAll('${HOME}', HOME).replaceAll('$HOME', HOME));
  const dangerousTarget = (target, cwd) => {
    if (target.startsWith('$')) {
      const [, rest] = target.split(/\/(.*)/s);
      return rest === undefined || rest === '' || rest === '*' ? `a path variable that may be empty: ${target}` : null;
    }
    const full = real(isAbsolute(target) ? target : join(cwd, target));
    if (full === '/') return 'the root folder';
    if (ancestorOrSame(full, HOME)) return `the home folder or above: ${full}`;
    return null;
  };
  /** null when the command may run; else the reason. */
  return function check(command, cwd) {
    const s = String(command ?? '');
    if (FORK_BOMB.test(s)) return 'a fork bomb';
    let where = real(cwd || HOME);
    for (const seg of segments(s)) {
      if (seg[0] === 'cd' && seg.length > 1) {
        const t = expandHome(seg[1]);
        where = real(isAbsolute(t) ? t : join(where, t));
        continue;
      }
      const head = basename(seg[0] ?? '');
      if (head === 'rm') {
        const flags = seg.slice(1).filter((a) => a.startsWith('-') && a.length > 1);
        const recursive = flags.some((a) => a === '--recursive' || (!a.startsWith('--') && /[rR]/.test(a)));
        if (recursive) {
          for (const t of seg.slice(1).filter((a) => !a.startsWith('-'))) {
            const why = dangerousTarget(expandHome(t), where);
            if (why) return `rm -r on ${why}`;
          }
        }
      }
      if (head === 'git' && seg[1] === 'clean' && seg.slice(2).some((a) => a.startsWith('-') && a.includes('f') && !a.includes('n'))) return 'git clean -f (look first with -n)';
      if (head === 'git' && seg[1] === 'reset' && seg.includes('--hard')) return 'git reset --hard';
      if (/^mkfs(\.|$)/.test(head)) return 'formatting a file system';
      if (head === 'dd' && seg.some((a) => /^of=\/dev\//.test(a))) return 'dd onto a device';
    }
    return null;
  };
}

export const checkCommand = makeGuard();
