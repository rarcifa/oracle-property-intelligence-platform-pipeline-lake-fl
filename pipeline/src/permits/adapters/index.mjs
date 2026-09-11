import { createClick2GovAdapter } from "./click2gov.mjs";
import { createJaxEpicsAdapter } from "./jaxepics.mjs";
// FIRST edit to a file this kit shipped (every earlier change to the runtime was
// an addition) — recorded in docs/lake-kit-deviations.md section 21.
//
// `permit-profile.mjs` has always admitted `etrakit` as an adapter key; until
// Lake County it had no implementation behind it, so a profile naming it failed
// at dispatch. The module lives beside the county that needed it because its
// portal knowledge is Clermont's, but the contract it implements is this
// registry's and any eTRAKiT jurisdiction can be pointed at it.
import { createEtrakitAdapter } from "../../counties/lake/etrakit-adapter.mjs";

const adapterFactories = Object.freeze({
  click2gov: createClick2GovAdapter,
  etrakit: createEtrakitAdapter,
  jaxepics: createJaxEpicsAdapter,
});

export function createPermitAdapter(jurisdiction, options = {}) {
  if (!jurisdiction.adapterKey) return null;
  const factory = adapterFactories[jurisdiction.adapterKey];
  if (!factory) {
    throw new Error(
      `Permit adapter "${jurisdiction.adapterKey}" is not implemented`,
    );
  }
  return factory(jurisdiction, options);
}

export const implementedPermitAdapterKeys = Object.freeze(
  Object.keys(adapterFactories).sort(),
);
