// Tests that look at the page source compare code with the layout taken out: no whitespace, no trailing commas and no last
// semicolon before a closing brace. Both the source and the expected snippet go through it, so a check holds however the code
// is formatted (npm run format) and fails only when the code itself changes.
export const squash = (s) =>
  String(s)
    .replace(/\s+/g, '')
    .replace(/,(?=[)\]}])/g, '')
    .replace(/;(?=})/g, '');
