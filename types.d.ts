// FR3: service templates imported `with { type: 'text' }`
declare module '*.tmpl' {
  const text: string
  export default text
}
