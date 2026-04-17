export interface PickedElement {
  tagName: string;
  text: string;
  attrs: Record<string, string>;

  // locator candidates (gathered in one pass on the browser side)
  testId?: string;        // data-testid / data-test / data-cy, whichever first
  ariaLabel?: string;
  role?: string;          // explicit [role=...]
  classPath: string;      // tag+class path, no nth-child
  nthChildPath: string;   // tag+:nth-of-type path, no classes
  cssPath: string;        // combined tag+class+nth-of-type (current)
}

export interface TagLocator {
  testId?: string;
  ariaLabel?: string;
  role?: string;
  text?: string;
  classPath?: string;
  nthChildPath?: string;
  cssPath: string;         // required fallback
}

export interface Tag {
  id: string;
  name: string;
  locator: TagLocator;
  capturedAt: number;
  preview: {
    tagName: string;
    text: string;
  };
}

export const SCHEMA_VERSION = 1;

export interface PersistedTags {
  domain: string;
  schemaVersion: number;
  tags: Tag[];
}
