import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const cvDocuments=sqliteTable("cv_documents",{
 key:text("key").primaryKey(),
 revision:integer("revision").notNull().default(0),
 payload:text("payload").notNull(),
});
