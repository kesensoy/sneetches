import { createAnnotation, createErrorAnnotation } from '../src/content';

describe('createAnnotation', () => {
  const data = {
    forks_count: 10,
    pushed_at: '2018-09-10',
    stargazers_count: 10,
  };

  test('stars annotation uses SVG icon', () => {
    const elt = createAnnotation(data, { forks: false, stars: true, update: false }, 'outline');
    expect(elt.outerHTML).toMatch('class="data-sneetch-extension"');
    expect(elt.outerHTML).toMatch('<svg');
    expect(elt.textContent?.trim()).toBe('10');
  });

  test('stars annotation uses filled SVG when starStyle=filled', () => {
    const elt = createAnnotation(data, { forks: false, stars: true, update: false }, 'filled');
    expect(elt.outerHTML).toMatch(/<svg/);
    // Starfill path data starts differently from star-outline; simplest check is
    // that the outputs for 'outline' vs 'filled' differ:
    const outlineElt = createAnnotation(
      data,
      { forks: false, stars: true, update: false },
      'outline'
    );
    expect(elt.outerHTML).not.toBe(outlineElt.outerHTML);
  });
});

describe('createErrorAnnotation', () => {
  const headers = { get: (_s: string) => '' };
  test('with a 403 and no an access token', () => {
    const elt = createErrorAnnotation({ status: 403, headers }, '');
    expect(elt.outerHTML).toMatch('class="data-sneetch-extension"');
    expect(elt.outerHTML).toMatch('title="Please set up your Github Personal Access Token"');
    expect(elt.innerText).toBe('⏳');
  });
  test('with an access token', () => {
    const elt = createErrorAnnotation({ status: 403, headers }, 'access token');
    expect(elt.outerHTML).not.toMatch('title="Please set up your Github Personal Access Token"');
  });
  test('for a missing repo', () => {
    const elt = createErrorAnnotation({ status: 404, headers }, '');
    expect(elt.outerHTML).toMatch(/class="[^"]* missing"/);
    expect(elt.innerText).toBe('missingⓍ');
  });
  test('with a unknown error', () => {
    const elt = createErrorAnnotation({ status: 410, headers }, '', (..._: unknown[]) => null);
    expect(elt.outerHTML).toMatch(/></);
    expect(elt.innerText).toBe('');
  });
});
