export type StoredDocument = {
  id: string;
  name: string;
  pages: string[];
  kind: string;
};

const globalStore = globalThis as typeof globalThis & { __datasheetDocs?: Map<string, StoredDocument> };
export const documents = globalStore.__datasheetDocs ??= new Map<string, StoredDocument>();
