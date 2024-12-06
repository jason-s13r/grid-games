export class R {
    _listeners = [];
    constructor(initialValue) {
      this._value = initialValue;
    }
    get value() {
      return this._value;
    }
    set value(value) {
      this._value = value;
      this.emit(value);
    }
    update(updater) {
      this.value = updater(this.value);
    }
    listen(callback) {
      callback(this.value);
      this._listeners.push(callback);
    }
    emit(value) {
      this._listeners.forEach((callback) => callback(value));
    }
  }