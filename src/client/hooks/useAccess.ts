import {createContext,useContext} from 'react';
export const AccessContext=createContext({admin:false});
export const useAccess=()=>useContext(AccessContext);
