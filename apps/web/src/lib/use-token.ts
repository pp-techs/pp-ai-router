import { useSyncExternalStore } from "react";
import { auth } from "../api/http.ts";

export const useToken = () => useSyncExternalStore(auth.subscribe, auth.token);
