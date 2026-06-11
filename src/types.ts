export type Env = {
    DB: D1Database;
    JWT_SECRET: string;
    JWT_ISSUER: string;
};

export type Variables = {
    userId: string;
    userRole: string;
    userEmail: string;
};
