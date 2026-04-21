// THROWAWAY — verify branch protection blocks merges when required checks fail.
// Intentional TypeScript error: assigning a string to a number-typed constant
// trips `tsc --noEmit`, which fails the required `CI / Typecheck (tsc)` check.
// Delete this file after verifying the merge button on main is disabled.
export const intentionalTypeError: number = "intentional type mismatch";
