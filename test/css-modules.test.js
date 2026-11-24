import { describe, expect, it } from 'vitest';
import { cssClass, cx } from '../src/styles/cssModules';

describe('CSS Modules isolation', () => {
  it('joins scoped class names and excludes disabled modifiers', () => {
    expect(cx('Help__wrap___abc12', false, undefined, 'Help__open___def34')).toBe(
      'Help__wrap___abc12 Help__open___def34',
    );
  });

  it('resolves generated module names with a diagnostic fallback', () => {
    expect(cssClass({ root: 'Ranking__root___abc12' }, 'root')).toBe('Ranking__root___abc12');
    expect(cssClass({}, 'missing')).toBe('missing');
  });
});
