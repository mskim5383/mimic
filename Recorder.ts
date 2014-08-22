/**
 * Functionality to record the execution of a javascript function by using proxies.
 *
 * @author Stefan Heule <stefanheule@gmail.com>
 */

"use strict";

import Util = require('./util/Util')
import Ansi = require('./util/Ansicolors')
import Data = require('./Data')

// enable proxies
import harmonyrefl = require('harmony-reflect');
harmonyrefl;
declare var Proxy: (target: Object, handler: Object) => Object;
declare var Reflect: any

var log = Util.log
var print = Util.print

/**
 * Record a trace for the given function and arguments.  In the `extended' mode, we additionally
 * store various intermediate results (e.g. those from all field reads, or the old value of field
 * writes) in local variables.  This is used to make program generation easier.
 */
export function record(f: (..._: any[]) => any, args: any[], extended: boolean = false): State {
    var state = new State(extended)

    args = Util.clone(args)

    // instrument args
    var iargs = []
    for (var i = 0; i < args.length; i++) {
        if (Util.isPrimitive(args[i])) {
            iargs[i] = args[i]
        } else {
            iargs[i] = proxify(state, args[i])
        }
        var ai = new Data.Argument(i)
        state.setPath(iargs[i], ai)
        state.addPrestate(iargs[i], ai)
        state.addCandidate(iargs[i], ai)
    }
    try {
        var res = f.apply(null, iargs);
        state.record(new Data.Return(getAccessPath(state, res)))
    } catch (e) {
        if (e instanceof Util.AssertionError) {
            throw e // don't catch our own errors
        }
        if (e instanceof ReferenceError) {
            var ee = <ReferenceError>e
            state.record(new Data.Throw(getAccessPath(state, ee.message.toString())))
        } else if (e instanceof TypeError) {
            var ee = <TypeError>e
            state.record(new Data.Throw(getAccessPath(state, ee.message.toString())))
        } else if (e instanceof RangeError) {
            var ee = <RangeError>e
            state.record(new Data.Throw(getAccessPath(state, ee.message.toString())))
        }
        else if (e instanceof SyntaxError) {
            var ee = <SyntaxError>e
            Util.assert(false, () => "syntax error: " + ee.toString() + "\n\nfor program: " + f.toString())
        } else {
            state.record(new Data.Throw(getAccessPath(state, e)))
        }
    }

    return state
}

/**
 * Given a program, compile it into a regular function.
 */
export function compile(prog: Data.Program): (...a: any[]) => any {
    return compile2(prog.toString())
}
/**
 * Like `compile', directly takes a string as input.
 */
export function compile2(prog: string): (...a: any[]) => any {
    return function (...a: any[]): any {
        return new Function('"use strict";' + prog).apply(null, a)
    }
}

export class State {
    // maps objects to an expression that can be used to access it
    private exprs: Map<any, Data.Expr> = new Map<any, Data.Expr>()
    // maps any value to a set of potential expressions that might be the
    // source of that value. for primitive, there is uncertainty in whether
    // these expressions really were the source, or whether they are the same
    // just by coincidence
    private candidates: Map<any, Data.Expr[]> = new Map<any, Data.Expr[]>()
    // map objects to their proxified object
    mapping: Map<Object, Object> = new Map<Object, Object>()
    // map proxified objects to their target
    mapping2: Map<Object, Object> = new Map<Object, Object>()
    public trace: Data.Trace = new Data.Trace()
    // all prestate expressions that are read
    private readPrestateObj: Map<any, Data.Expr> = new Map<any, Data.Expr>()
    private readPrestate: Data.Expr[] = []
    variables: Data.Var[] = []
    constructor(public extended: boolean) {
    }
    addPrestate(a: any, e: Data.Expr) {
        e.setValue(a)
        if (Util.isPrimitive(a)) {
            this.readPrestate.push(e)
        } else {
            this.readPrestate.push(e)
            this.readPrestateObj.set(a, e)
        }
    }
    hasPrestate(a: any) {
        return this.readPrestateObj.has(this.mapping.get(a))
    }
    getPrestate(a: any) {
        return this.readPrestateObj.get(this.mapping.get(a))
    }
    getPrestates() {
        var res = this.readPrestate.slice(0)
        //this.readPrestateObj.forEach((v, k) => res.push(v))
        return Util.dedup2(res)
    }
    getPath(a: any): Data.Expr {
        Util.assert(!Util.isPrimitive(a))
        var p = this.exprs.get(a)
        if (p !== undefined) return p
        return this.exprs.get(this.mapping.get(a))
    }
    setPath(a: any, v: Data.Expr) {
        this.exprs.set(a, v)
    }
    getCandidates(a: any): Data.Expr[] {
        var c = this.candidates.get(a) || []
        c = c.slice(0)
        if (Util.isPrimitive(a)) {
            c.push(new Data.Const(a))
        }
        return Util.dedup2(c)
    }
    addCandidate(a: any, v: Data.Expr) {
        this.candidates.set(a, [v].concat(this.getCandidates(a) || []))
    }
    setMapping(o: Object, p: Object) {
        Util.assert(!this.mapping.has(o));
        this.mapping.set(o, p)
        this.mapping2.set(p, o)
    }
    getMapping(o: Object) {
        return this.mapping.get(o)
    }
    getMapping2(o: Object) {
        return this.mapping2.get(o)
    }
    record(stmt: Data.Stmt) {
        if (stmt.type === Data.StmtType.Assign) {
            var lhs = (<Data.Assign>stmt).lhs;
            if (lhs.type === Data.ExprType.Var) {
                this.variables.push(<Data.Var>lhs)
            }
        }
        this.trace.extend(stmt)
    }
    toString() {
        return "State:\n  " + this.trace.stmts.join("\n  ")
    }
}

function getAccessPath(state: State, v: any): Data.Expr {
    if (Util.isPrimitive(v)) {
        return new Data.Const(v)
    }
    Util.assert(state.getPath(v) !== undefined, () => "getAccessPath(" + state + "," + Util.inspect(v, true) + ")")
    return state.getPath(v)
}

function proxify(state: State, o: Object) {
    if (state.getMapping(o) !== undefined) return state.getMapping(o)
    var common = function (target) {
        Util.assert(state.getPath(target) !== undefined, () => "target path undefined")
    }
    var ignorec = (a: any) => print(Ansi.lightgrey(a))
    ignorec = (a: any) => a
    var Handler = {
        get: function(target, name: string, receiver) {
            common(target)
            if (!(name in target) || target.hasOwnProperty(name)) {
                var val = target[name];
                var field = new Data.Field(state.getPath(target), new Data.Const(name))
                state.addCandidate(val, field)
                //log("reading " + name + " and got " + val)
                if (state.hasPrestate(target)) {
                    // we cannot use "field" directly, because that is only valid in the current state
                    // however, here we need an expression that is valid in the prestate
                    state.addPrestate(val, new Data.Field(state.getPrestate(target), new Data.Const(name)))
                }
                if (Util.isPrimitive(val)) {
                    if (state.extended) {
                        var variable = new Data.Var()
                        variable.setValue(val)
                        var ass = new Data.Assign(variable, field, true)
                        state.record(ass)
                    }
                    return val;
                } else {
                    var variable = new Data.Var()
                    variable.setValue(val)
                    var ass = new Data.Assign(variable, field, true)
                    state.record(ass)
                    var p = proxify(state, val)
                    state.setPath(p, variable)
                    return p
                }
            } else {
                // TODO handle properties that are somewhere else
                ignorec("ignoring access to '" + name + "'.")
            }
            return Reflect.get(target, name, receiver);
        },
        set: function(target, name: string, value, receiver) {
            common(target)
            // TODO: record ALL candidate paths (maybe?)
            var field = new Data.Field(state.getPath(target), new Data.Const(name));
            if (state.extended) {
                // record the old value in a variable
                var variable = new Data.Var()
                var ass = new Data.Assign(variable, field, true)
                state.record(ass)
            }
            var p = getAccessPath(state, value);
            var ass = new Data.Assign(field, p)
            state.record(ass)
            state.addCandidate(value, field)
            state.setPath(value, p)
            return Reflect.set(target, name, value, receiver);
        },
        has: function(target, name: string) {
            common(target)
            ignorec(".. unhandled call to has")
            return Reflect.has(target, name);
        },
        apply: function(target, receiver, args) {
            ignorec(".. unhandled call to apply")
            common(target)
            return Reflect.apply(target, receiver, args);
        },
        construct: function(target, args) {
            ignorec(".. unhandled call to construct")
            common(target)
            return Reflect.construct(target, args);
        },
        getOwnPropertyDescriptor: function(target, name: string) {
            ignorec(".. unhandled call to getOwnPropertyDescriptor for " + name + " on " + Util.inspect(target))
            common(target)
            return Reflect.getOwnPropertyDescriptor(target, name);
        },
        defineProperty: function(target, name: string, desc) {
            common(target)
            if ("value" in desc) {
                // TODO
                ignorec(".. unhandled call to defineProperty (ignore for now)")
                //state.record(new Data.DefineProp(getAccessPath(state, o), name, getAccessPath(state, desc.value)))
            } else {
                ignorec(".. unhandled call to defineProperty (unhandled type of descriptor)")
            }
            return Reflect.defineProperty(target, name, desc);
        },
        getOwnPropertyNames: function(target) {
            ignorec(".. unhandled call to getOwnPropertyNames")
            common(target)
            return Reflect.getOwnPropertyNames(target);
        },
        getPrototypeOf: function(target) {
            ignorec(".. unhandled call to getPrototypeOf")
            common(target)
            return Reflect.getPrototypeOf(target);
        },
        setPrototypeOf: function(target, newProto) {
            ignorec(".. unhandled call to setPrototypeOf")
            common(target)
            return Reflect.setPrototypeOf(target, newProto);
        },
        deleteProperty: function(target, name: string) {
            common(target)
            var obj = getAccessPath(state, o);
            var f = new Data.Const(name);
            var field = new Data.Field(obj, f);
            if (state.extended) {
                // record the old value in a variable
                var variable = new Data.Var()
                var ass = new Data.Assign(variable, field, true)
                state.record(ass)
            }
            state.record(new Data.DeleteProp(obj, f))
            return Reflect.deleteProperty(target, name);
        },
        enumerate: function(target) {
            ignorec(".. unhandled call to enumerate")
            common(target)
            return Reflect.enumerate(target);
        },
        preventExtensions: function(target) {
            ignorec(".. unhandled call to preventExtensions")
            common(target)
            return Reflect.preventExtensions(target);
        },
        isExtensible: function(target) {
            ignorec(".. unhandled call to isExtensible on "+Util.inspect(target))
            common(target)
            return Reflect.isExtensible(target);
        },
        ownKeys: function(target) {
            ignorec(".. unhandled call to ownKeys")
            common(target)
            return Reflect.ownKeys(target);
        }
    }
    var p = Proxy(o, Handler)
    state.setMapping(o, p)
    return p
}

/**
 * Proxify the object `o', and log all behavior (in addition to actually performing the actions).
 */
export function proxifyWithLogger<T>(o: T): T {
    var common = function (target) {
    }
    var logaccess = (a: any) => print(Ansi.lightgrey(a))
    var Handler = {
        get: function(target, name: string, receiver) {
            common(target)
            var value = Reflect.get(target, name, receiver);
            var s = "get of " + name;
            if (Util.isPrimitive(value)) {
                s += " (yields " + value + ")"
            }
            logaccess(s)
            return value;
        },
        set: function(target, name: string, value, receiver) {
            common(target)
            var s = "set of " + name;
            if (Util.isPrimitive(value)) {
                s += " (with value " + value + ")"
            }
            logaccess(s)
            return Reflect.set(target, name, value, receiver);
        },
        has: function(target, name: string) {
            common(target)
            logaccess("has of " + name)
            return Reflect.has(target, name);
        },
        apply: function(target, receiver, args) {
            logaccess("apply")
            common(target)
            return Reflect.apply(target, receiver, args);
        },
        construct: function(target, args) {
            logaccess("construct")
            common(target)
            return Reflect.construct(target, args);
        },
        getOwnPropertyDescriptor: function(target, name: string) {
            logaccess("getOwnPropertyDescriptor for " + name)
            common(target)
            return Reflect.getOwnPropertyDescriptor(target, name);
        },
        defineProperty: function(target, name: string, desc) {
            common(target)
            logaccess("defineProperty for " + name)
            return Reflect.defineProperty(target, name, desc);
        },
        getOwnPropertyNames: function(target) {
            logaccess("getOwnPropertyNames")
            common(target)
            return Reflect.getOwnPropertyNames(target);
        },
        getPrototypeOf: function(target) {
            logaccess("getPrototypeOf")
            common(target)
            return Reflect.getPrototypeOf(target);
        },
        setPrototypeOf: function(target, newProto) {
            logaccess("setPrototypeOf")
            common(target)
            return Reflect.setPrototypeOf(target, newProto);
        },
        deleteProperty: function(target, name: string) {
            common(target)
            logaccess("deleteProperty for " + name)
            return Reflect.deleteProperty(target, name);
        },
        enumerate: function(target) {
            logaccess("enumerate")
            common(target)
            return Reflect.enumerate(target);
        },
        preventExtensions: function(target) {
            logaccess("preventExtensions")
            common(target)
            return Reflect.preventExtensions(target);
        },
        isExtensible: function(target) {
            logaccess("isExtensible")
            common(target)
            return Reflect.isExtensible(target);
        },
        ownKeys: function(target) {
            logaccess("ownKeys")
            common(target)
            return Reflect.ownKeys(target);
        }
    }
    var p = Proxy(o, Handler)
    return <T>p
}
