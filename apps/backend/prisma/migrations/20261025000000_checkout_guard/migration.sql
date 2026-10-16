CREATE TABLE "billing_checkouts" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "polarCheckoutId" TEXT NOT NULL UNIQUE,
  "productId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  CONSTRAINT "billing_checkouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
