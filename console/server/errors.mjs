export function fail(status,code,message){throw Object.assign(new Error(message),{status,code})}
export function invalid(message){fail(400,'invalid_request',message)}
export function denied(){fail(403,'forbidden','You do not have access to this resource')}
export function missing(){fail(404,'not_found','Resource not found')}
