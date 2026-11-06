// The EMV2 standard error type library (SAE AS5506/1A Annex E), contributed
// read-only by the EMV2 plug-in. Type names follow the standard hierarchy.

export const ERROR_LIBRARY = `package ErrorLibrary
public
  annex EMV2 {**
    error types
      ServiceError: type;
        ItemOmission: type extends ServiceError;
        ServiceOmission: type extends ServiceError;
        SequenceOmission: type extends ServiceError;
          TransientServiceOmission: type extends ServiceOmission;
          LateServiceStart: type extends ServiceOmission;
          EarlyServiceTermination: type extends ServiceOmission;
          BoundedOmissionInterval: type extends SequenceOmission;
        ItemCommission: type extends ServiceError;
        ServiceCommission: type extends ServiceError;
        SequenceCommission: type extends ServiceError;
          EarlyServiceStart: type extends ServiceCommission;
          LateServiceTermination: type extends ServiceCommission;

      TimingRelatedError: type;
        ItemTimingError: type extends TimingRelatedError;
          EarlyDelivery: type extends ItemTimingError;
          LateDelivery: type extends ItemTimingError;
        SequenceTimingError: type extends TimingRelatedError;
          HighRate: type extends SequenceTimingError;
          LowRate: type extends SequenceTimingError;
          RateJitter: type extends SequenceTimingError;
        ServiceTimingError: type extends TimingRelatedError;
          DelayedService: type extends ServiceTimingError;
          EarlyService: type extends ServiceTimingError;

      ValueRelatedError: type;
        ItemValueError: type extends ValueRelatedError;
          UndetectableValueError: type extends ItemValueError;
          DetectableValueError: type extends ItemValueError;
            OutOfRange: type extends DetectableValueError;
              BelowRange: type extends OutOfRange;
              AboveRange: type extends OutOfRange;
        SequenceValueError: type extends ValueRelatedError;
          BoundedValueChange: type extends SequenceValueError;
          StuckValue: type extends SequenceValueError;
          OutOfOrder: type extends SequenceValueError;
        ServiceValueError: type extends ValueRelatedError;
          OutOfCalibration: type extends ServiceValueError;

      ReplicationError: type;
        AsymmetricReplicatesError: type extends ReplicationError;
          AsymmetricValue: type extends AsymmetricReplicatesError;
          AsymmetricApproximateValue: type extends AsymmetricValue;
          AsymmetricExactValue: type extends AsymmetricValue;
          AsymmetricOmission: type extends AsymmetricReplicatesError;
          AsymmetricItemOmission: type extends AsymmetricOmission;
          AsymmetricServiceOmission: type extends AsymmetricOmission;
          AsymmetricTiming: type extends AsymmetricReplicatesError;
        SymmetricReplicatesError: type extends ReplicationError;
          SymmetricValue: type extends SymmetricReplicatesError;
          SymmetricOmission: type extends SymmetricReplicatesError;
          SymmetricTiming: type extends SymmetricReplicatesError;

      ConcurrencyError: type;
        RaceCondition: type extends ConcurrencyError;
          ReadWriteRace: type extends RaceCondition;
          WriteWriteRace: type extends RaceCondition;
        MutExError: type extends ConcurrencyError;
          Deadlock: type extends MutExError;
          Starvation: type extends MutExError;

      AuthorizationError: type;
      AuthenticationError: type;

      CommonErrors: type set {ServiceError, TimingRelatedError, ValueRelatedError};
    end types;

    error behavior FailStop
      events
        Failure: error event;
      states
        Operational: initial state;
        FailStop: state;
      transitions
        Operational -[ Failure ]-> FailStop;
    end behavior;

    error behavior FailAndRecover
      events
        Failure: error event;
        Recover: recover event;
      states
        Operational: initial state;
        Failed: state;
      transitions
        Operational -[ Failure ]-> Failed;
        Failed -[ Recover ]-> Operational;
    end behavior;

    error behavior RecoverableFailure
      events
        Failure: error event;
        Repair: repair event;
        Degrade: error event;
      states
        Operational: initial state;
        Degraded: state;
        Failed: state;
      transitions
        Operational -[ Degrade ]-> Degraded;
        Degraded -[ Failure ]-> Failed;
        Operational -[ Failure ]-> Failed;
        Failed -[ Repair ]-> Operational;
    end behavior;
  **};
end ErrorLibrary;
`;
