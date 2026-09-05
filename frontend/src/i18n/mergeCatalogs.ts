export type TranslationCatalog = Record<string, any>;

type UnionToIntersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (value: infer Intersection) => void
  ? Intersection
  : never;

const isCatalog = (value: unknown): value is TranslationCatalog => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const mergeCatalogs = <const Catalogs extends readonly TranslationCatalog[]>(...catalogs: Catalogs): UnionToIntersection<Catalogs[number]> => {
  const merged: TranslationCatalog = {};
  for (const catalog of catalogs) {
    for (const [key, value] of Object.entries(catalog)) {
      const current = merged[key];
      merged[key] = isCatalog(current) && isCatalog(value)
        ? mergeCatalogs(current, value)
        : value;
    }
  }
  return merged as UnionToIntersection<Catalogs[number]>;
};