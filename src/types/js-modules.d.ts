// Faz o TS aceitar imports de qualquer .js sem tipagem
declare module '*.js' {
  const mod: any;
  export default mod;
}

declare module '*.wasm' {
  const path: string;
  export default path;
}
