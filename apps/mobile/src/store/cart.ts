import { create } from "zustand";

interface CartProduct {
  id: string;
  name: string;
  icon: string;
  unit: string;
  basePrice: number;
  gstPercent: number;
}

interface CartItem extends CartProduct {
  quantity: number;
  lineSubtotal: number;
  lineGst: number;
  lineTotal: number;
}

interface CartState {
  items: Record<string, CartItem>;
  paymentMode: "wallet" | "upi" | "credit";

  addItem: (product: CartProduct) => void;
  removeItem: (productId: string) => void;
  setQuantity: (productId: string, qty: number) => void;
  setPaymentMode: (mode: "wallet" | "upi" | "credit") => void;
  clearCart: () => void;

  // Computed
  getItems: () => CartItem[];
  getItemCount: () => number;
  getSubtotal: () => number;
  getTotalGst: () => number;
  getGrandTotal: () => number;
}

function calcLine(price: number, gst: number, qty: number) {
  const sub = price * qty;
  const gstAmt = sub * (gst / 100);
  return { lineSubtotal: sub, lineGst: gstAmt, lineTotal: sub + gstAmt };
}

export const useCartStore = create<CartState>((set, get) => ({
  items: {},
  paymentMode: "wallet",

  addItem: (product) => {
    set((state) => {
      const existing = state.items[product.id];
      const qty = (existing?.quantity ?? 0) + 1;
      const line = calcLine(product.basePrice, product.gstPercent, qty);
      return {
        items: { ...state.items, [product.id]: { ...product, quantity: qty, ...line } },
      };
    });
  },

  removeItem: (productId) => {
    set((state) => {
      const existing = state.items[productId];
      if (!existing || existing.quantity <= 1) {
        const { [productId]: _, ...rest } = state.items;
        return { items: rest };
      }
      const qty = existing.quantity - 1;
      const line = calcLine(existing.basePrice, existing.gstPercent, qty);
      return {
        items: { ...state.items, [productId]: { ...existing, quantity: qty, ...line } },
      };
    });
  },

  setQuantity: (productId, qty) => {
    set((state) => {
      if (qty <= 0) {
        const { [productId]: _, ...rest } = state.items;
        return { items: rest };
      }
      const existing = state.items[productId];
      if (!existing) return state;
      const line = calcLine(existing.basePrice, existing.gstPercent, qty);
      return {
        items: { ...state.items, [productId]: { ...existing, quantity: qty, ...line } },
      };
    });
  },

  setPaymentMode: (mode) => set({ paymentMode: mode }),
  clearCart: () => set({ items: {}, paymentMode: "wallet" }),

  getItems: () => Object.values(get().items).filter((i) => i.quantity > 0),
  getItemCount: () => Object.values(get().items).reduce((a, i) => a + i.quantity, 0),
  getSubtotal: () => Object.values(get().items).reduce((a, i) => a + i.lineSubtotal, 0),
  getTotalGst: () => Object.values(get().items).reduce((a, i) => a + i.lineGst, 0),
  getGrandTotal: () => Object.values(get().items).reduce((a, i) => a + i.lineTotal, 0),
}));
