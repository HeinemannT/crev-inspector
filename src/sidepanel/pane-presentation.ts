export interface PanePresentation {
  body: 'standard' | 'property';
  requestSchema: boolean;
  customRelationships: boolean;
  showTargetToggle: boolean;
}

/** Keep special-pane behavior in one policy so schema, relationships, target
 * controls, and body rendering cannot drift into a hybrid view. */
export function panePresentation(type: string, isPropertyDefinition: boolean): PanePresentation {
  if (isPropertyDefinition) {
    return {
      body: 'property',
      requestSchema: false,
      customRelationships: true,
      showTargetToggle: false,
    };
  }
  if (type === 'EditField') {
    return {
      body: 'standard',
      requestSchema: false,
      customRelationships: true,
      showTargetToggle: true,
    };
  }
  return {
    body: 'standard',
    requestSchema: true,
    customRelationships: false,
    showTargetToggle: true,
  };
}
