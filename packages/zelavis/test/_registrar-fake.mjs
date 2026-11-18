import { defineRegistrars } from "../dist/edge/registrar-provider.js";
export const contact = { firstName: "Test", lastName: "Owner", address1: "1 Example Street", city: "City", stateProvince: "CA", postalCode: "90001", country: "US", phone: "+1.5555550100", email: "owner@example.com" };
export const price = { amount: "10.0000", currency: "USD", years: 1 };
export function fakeRegistrar() {
  const state = { owned: new Map(), calls: [], transfer: "pending", submit: undefined, price: { ...price } };
  const definition = { name: "fake", title: "Fake registrar", credentials: [{ name: "token", label: "Token", secret: true }], tokenGuidance: "Only the local fake registrar.", createClient(credentials, context) {
    if (credentials.token !== "test-secret") throw new Error("test-secret was refused");
    return {
      check: async domains => domains.map(domain => ({ domain, available: !state.owned.has(domain), premium: false, price: state.price })),
      price: async () => state.price, quote: async (_domain, _action, years) => ({ ...state.price, years }),
      register: async input => { state.calls.push({ kind: "register", domain: input.domain }); if (state.submit) return state.submit(input, context); state.owned.set(input.domain, "2027-11-16T00:00:00.000Z"); return { registrarOrderId: "order-1" }; },
      renew: async input => { state.calls.push({ kind: "renew", domain: input.domain }); if (state.submit) return state.submit(input, context); state.owned.set(input.domain, "2028-11-16T00:00:00.000Z"); return { registrarOrderId: "renew-1" }; },
      transfer: async input => { state.calls.push({ kind: "transfer", domain: input.domain }); if (state.submit) return state.submit(input, context); return { transferId: "transfer-1" }; },
      transferStatus: async () => ({ state: state.transfer }),
      domain: async domain => ({ owned: state.owned.has(domain), ...(state.owned.has(domain) ? { expiresAt: state.owned.get(domain) } : {}) }),
      domains: async () => ({ domains: [...state.owned].map(([domain, expiresAt]) => ({ domain, expiresAt })) }),
      setNameservers: async (domain, nameservers) => { state.nameservers = { domain, nameservers }; },
    };
  } };
  return { state, definition, plugin: defineRegistrars("@test/registrar", [definition]) };
}
