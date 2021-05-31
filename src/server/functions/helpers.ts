import { IFunctionDefinition } from '../../functions';
import { EndpointContext, EndpointFunction, EndpointHandler } from './interface';
import { Middleware as MiddlewareClass } from './middleware';

export namespace SpecTo {
    export function Handler<A, R, F extends EndpointHandler<A, R, C>, C = never>(_spec: IFunctionDefinition<A, R>, func: F, _context?: C) {
        return func;
    }

    export function Function<A, R, F extends EndpointFunction<A, R, C>, C = never>(_spec: IFunctionDefinition<A, R>, func: F, _context?: C) {
        return func;
    }

    export function Middleware<A, R, C = never>(_spec: IFunctionDefinition<A, R>, _context?: C) {
        return new MiddlewareClass<A, R, C>();
    }
}

export namespace ContextTo {

    export function Handler<C, F extends EndpointHandler<any, any, C>>(_c: C, func: F): F {
        return func;
    }

    export function Populist<T, F extends (ctx: EndpointContext<T>) => Promise<void>>(_c: T, func: F) {
        return func;
    }

}
