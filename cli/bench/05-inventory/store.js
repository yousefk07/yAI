// An in-memory stock list for a small shop.

class Store {
  constructor(items = []) {
    this.items = new Map();
    for (const { name, qty, price } of items) this.items.set(name, { name, qty, price });
  }

  // Removes `qty` units of an item when it's sold.
  sell(name, qty) {
    const item = this.items.get(name);
    item.qty -= qty;
    return item.qty;
  }

  list() {
    return [...this.items.values()];
  }
}

module.exports = { Store };
