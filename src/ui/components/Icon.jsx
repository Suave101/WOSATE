/** A VS Code codicon, e.g. <Icon name="files" />. */
export function Icon({ name, className = "", title }) {
  return <i className={`codicon codicon-${name} ${className}`.trim()} aria-hidden={title ? undefined : "true"} title={title} />;
}
