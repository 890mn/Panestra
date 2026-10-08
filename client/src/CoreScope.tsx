import { createContext, useContext } from 'react';
import { core, type CoreClient } from './core';

export const CoreScope = createContext<CoreClient>(core);
export const useCoreClient = () => useContext(CoreScope);
