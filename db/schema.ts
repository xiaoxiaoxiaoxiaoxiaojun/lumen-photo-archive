import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const photos = sqliteTable("photos", {
  id: text("id").primaryKey(),
  objectKey: text("object_key").notNull().unique(),
  title: text("title").notNull(),
  category: text("category").notNull().default("旅途"),
  location: text("location").notNull().default(""),
  capturedAt: text("captured_at").notNull().default(""),
  contentType: text("content_type").notNull(),
  ownerSub: text("owner_sub").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("photos_created_at_idx").on(table.createdAt)]);
