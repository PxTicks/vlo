/**
 * Typed stand-ins for third-party library objects (Pixi, mediabunny, WebCodecs)
 * in tests that replace those libraries.
 *
 * A hand-written mock that invents its own shapes agrees with whatever the
 * code under test assumes, so a wrong assumption passes every test. Building
 * fakes through `fake<T>()`, and declaring fake classes as
 * `implements Partial<RealClass>`, checks every member a test supplies against
 * the installed library's declaration: a fake that returns the wrong shape
 * fails typecheck instead of hiding the bug.
 *
 * Spies need their signature too. An unparameterised `vi.fn()` returns `any`,
 * which satisfies every member type, so `pixels: vi.fn().mockReturnValue(x)`
 * passes whatever `x` is. Write `vi.fn<ExtractSystem["pixels"]>()` so the
 * values a test configures are checked as well. For an overloaded or generic
 * member, give the spy the one signature the code under test calls.
 */

/**
 * A `T` built from only the members a test needs. Supplied members are
 * type-checked against `T`; omitted members are absent at runtime, so the
 * code under test must not reach them. Nest `fake()` for library objects that
 * a fake method returns.
 */
export function fake<T>(members: Partial<T>): T {
  return members as T;
}
