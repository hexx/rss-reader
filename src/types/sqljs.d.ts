declare module 'sql.js' {
  export interface SqlJsConfig {
    locateFile?(fileName: string): string;
  }

  export interface SqlJsDatabase {
    exec(sql: string): void;
  }

  export interface SqlJsModule {
    Database: new () => SqlJsDatabase;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsModule>;
}
