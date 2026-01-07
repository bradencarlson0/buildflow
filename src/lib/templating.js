export const fillTemplate = (template, vars) => {
  const source = template == null ? '' : String(template)
  const values = vars && typeof vars === 'object' ? vars : {}
  return source.replaceAll(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = values[key]
    return value == null ? '' : String(value)
  })
}

