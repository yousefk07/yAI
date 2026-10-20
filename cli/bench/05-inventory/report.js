// Reports built from a Store.

// Total value of everything in stock, rounded to the cent.
function stockValue(store) {
  return store.list().reduce((sum, i) => sum + i.qty * i.price, 0);
}

module.exports = { stockValue };
