// The mark a form wears in lists (its uploaded logo, else its chosen icon), in the same shape the Forms list already sends as
// `branding`. Lists built from a form but not from the full form document (analytics, shared with me, My submissions) used to leave it
// out, so the same form was a logo in one place and a generic document in another.
export const formMark = (form: { branding?: { logoUrl?: string | null; iconName?: string | null } | null }): { logoUrl: string | null; iconName: string | null } => ({
  logoUrl: form.branding?.logoUrl || null,
  iconName: form.branding?.iconName || null,
});
